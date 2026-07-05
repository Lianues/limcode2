import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { InFlight } from '../chat/components';
import { spawnToolCallEvent } from './bundles';
import { ToolCall, ToolState, type ToolCallData, type ToolStateData } from './components';
import { isTerminalToolStatus, transitionToolState } from './state';

export const TOOL_INTERRUPTED_MESSAGE = '工具已被用户中断执行。';

/** 统一的“被用户中断”工具响应 payload：模型侧会看到 interrupted 标记与说明文案。 */
export function interruptedToolResult(reason?: string): { ok: false; interrupted: true; error: string } {
  return { ok: false, interrupted: true, error: reason ?? TOOL_INTERRUPTED_MESSAGE };
}

/**
 * 把一个非终态工具调用标记为“被用户中断执行”：写入终态 error 结果、移除 InFlight、补一条 failed 事件，
 * 并（对可能仍在外部执行的运行时工具）尽力 emit tool.abort 触发真中断。
 * 已终态则直接跳过，保证幂等——命令工具转后台后是终态 success（已返回成功给 AI），不受中断影响。
 */
export function interruptToolCall(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  options: { reason?: string; emitAbort?: boolean } = {}
): boolean {
  if (isTerminalToolStatus(state.status)) return false;

  const now = Date.now();
  const result = interruptedToolResult(options.reason);
  cmd.add(entity, ToolState, transitionToolState(state, 'error', {
    error: result.error,
    result,
    durationMs: Math.max(0, now - call.createdAt)
  }, now));
  cmd.remove(entity, InFlight);
  spawnToolCallEvent(cmd, {
    toolCall: entity,
    toolCallId: call.id,
    kind: 'failed',
    status: 'error',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs: Math.max(0, now - call.createdAt),
    error: result.error,
    payload: result
  });
  if (options.emitAbort !== false) {
    cmd.effect({ kind: 'tool.abort', toolCallId: call.id });
  }
  return true;
}

/** 便捷读取：按实体取出 call/state 后调用 interruptToolCall。 */
export function interruptToolCallEntity(
  cmd: CommandSink,
  world: WorldReader,
  entity: Entity,
  options: { reason?: string; emitAbort?: boolean } = {}
): boolean {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  if (!call || !state) return false;
  return interruptToolCall(cmd, entity, call, state, options);
}
