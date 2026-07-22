import type { Entity, WorldReader } from '../../../ecs/types';
import { Message, PartOf } from '../chat/components';
import { ToolCall, ToolResultConsumed, ToolState } from '../tools/components';
import { isTerminalToolStatus } from '../tools/state';
import {
  isFunctionCallPart,
  isFunctionResponsePart,
  isTextPart,
  type MessageContent
} from '../../../../shared/protocol';

export interface ClosedCompressionBoundary {
  entity: Entity;
  id: string;
  seq: number;
  role: string;
}

export interface ClosedCompressionBoundaryOptions {
  minSeq?: number;
  maxSeq?: number;
}

/**
 * 从给定消息集合中选择最新的安全压缩边界。
 *
 * 安全边界只能是：
 * - 不含工具调用的模型正式回答；
 * - 已落地的工具结果。
 *
 * 同时会拒绝任何仍包含活动未闭合工具调用的候选范围，避免把 functionCall / functionResponse 拆开。
 */
export function selectLatestClosedCompressionBoundary(
  world: WorldReader,
  entities: readonly Entity[],
  options: ClosedCompressionBoundaryOptions = {}
): ClosedCompressionBoundary | undefined {
  const minSeq = finiteSeq(options.minSeq) ?? Number.NEGATIVE_INFINITY;
  const maxSeq = finiteSeq(options.maxSeq) ?? Number.POSITIVE_INFINITY;
  const ordered = [...entities]
    .filter((entity) => {
      const message = world.get(entity, Message);
      return !!message && message.status !== 'streaming' && message.seq <= maxSeq;
    })
    .sort((left, right) => {
      const a = world.get(left, Message)!;
      const b = world.get(right, Message)!;
      return a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entity = ordered[index];
    const message = world.get(entity, Message);
    if (!message || message.seq < minSeq || !isClosedCompressionBoundary(message.content)) continue;
    const throughCandidate = ordered.slice(0, index + 1);
    if (hasActiveUnresolvedFunctionCallsInEntities(world, throughCandidate)) continue;
    return { entity, id: message.id, seq: message.seq, role: message.role };
  }
  return undefined;
}

export function isClosedCompressionBoundary(content: MessageContent | undefined): boolean {
  if (!content) return false;
  if (content.role === 'model') {
    return content.parts.some((part) => isTextPart(part) && part.thought !== true && part.text.trim().length > 0)
      && !content.parts.some(isFunctionCallPart);
  }
  return content.role === 'user' && content.parts.some(isFunctionResponsePart);
}

export function hasActiveUnresolvedFunctionCallsInEntities(world: WorldReader, entities: readonly Entity[]): boolean {
  const pendingCallIds = new Map<string, PendingFunctionCall>();
  const pendingCallNames = new Map<string, PendingFunctionCall[]>();

  for (const entity of entities) {
    const content = world.get(entity, Message)?.content;
    if (!content) continue;
    for (const part of content.parts) {
      if (isFunctionCallPart(part)) {
        const callId = part.id?.trim();
        const pending: PendingFunctionCall = {
          ...(callId ? { id: callId } : {}),
          name: part.functionCall.name,
          message: entity
        };
        if (callId) {
          pendingCallIds.set(callId, pending);
        } else {
          const calls = pendingCallNames.get(part.functionCall.name) ?? [];
          calls.push(pending);
          pendingCallNames.set(part.functionCall.name, calls);
        }
        continue;
      }

      if (!isFunctionResponsePart(part)) continue;
      const callId = part.id?.trim();
      if (callId && pendingCallIds.delete(callId)) continue;
      const pendingByName = pendingCallNames.get(part.functionResponse.name);
      if (!pendingByName?.length) continue;
      pendingByName.shift();
      if (pendingByName.length === 0) pendingCallNames.delete(part.functionResponse.name);
    }
  }

  const pendingCalls = [
    ...pendingCallIds.values(),
    ...[...pendingCallNames.values()].flat()
  ];
  return pendingCalls.some((call) => isActiveUnresolvedFunctionCall(world, call));
}

interface PendingFunctionCall {
  id?: string;
  name: string;
  message: Entity;
}

function isActiveUnresolvedFunctionCall(world: WorldReader, call: PendingFunctionCall): boolean {
  const toolCall = findToolCallForFunctionCall(world, call);
  if (toolCall === undefined) return false;
  const state = world.get(toolCall, ToolState);
  if (!state) return false;
  return !isTerminalToolStatus(state.status) || !world.has(toolCall, ToolResultConsumed);
}

function findToolCallForFunctionCall(world: WorldReader, call: PendingFunctionCall): Entity | undefined {
  return world.query(ToolCall, ToolState).find((entity) => {
    const data = world.get(entity, ToolCall);
    if (!data || data.name !== call.name) return false;
    if (call.id && (data.id === call.id || data.functionCallId === call.id)) return true;
    return world.get(entity, PartOf)?.parent === call.message;
  });
}

function finiteSeq(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
