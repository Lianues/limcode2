import type {
  ClientState,
  LlmInvocationRecord,
  MessageLlmInvocationLinkRecord,
  RunLlmInvocationLinkRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { AgentRun } from '../agentRun/components';
import { Message } from '../chat/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from './components';

export const llmStateProjectionReads: AccessDeclaration = {
  components: [LlmInvocation, RunLlmInvocationLink, MessageLlmInvocationLink, AgentRun, Message]
};

export function projectLlmState(world: WorldReader): Partial<ClientState> {
  return {
    llmInvocations: world.query(LlmInvocation).map((entity): LlmInvocationRecord => ({ ...world.get(entity, LlmInvocation)! })),
    runLlmInvocationLinks: world.query(RunLlmInvocationLink).map((entity) => buildRunInvocationLinkRecord(world, entity)).filter(isDefined),
    messageLlmInvocationLinks: world.query(MessageLlmInvocationLink).map((entity) => buildMessageInvocationLinkRecord(world, entity)).filter(isDefined)
  };
}

function buildRunInvocationLinkRecord(world: WorldReader, entity: number): RunLlmInvocationLinkRecord | undefined {
  const link = world.get(entity, RunLlmInvocationLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const invocation = world.get(link.invocation, LlmInvocation);
  if (!run || !invocation) return undefined;
  return { id: link.id, runId: run.id, invocationId: invocation.id, role: link.role, createdAt: link.createdAt, updatedAt: link.updatedAt };
}

function buildMessageInvocationLinkRecord(world: WorldReader, entity: number): MessageLlmInvocationLinkRecord | undefined {
  const link = world.get(entity, MessageLlmInvocationLink);
  if (!link) return undefined;
  const message = world.get(link.message, Message);
  const invocation = world.get(link.invocation, LlmInvocation);
  if (!message || !invocation) return undefined;
  return { id: link.id, messageId: message.id, invocationId: invocation.id, role: link.role, createdAt: link.createdAt, updatedAt: link.updatedAt };
}

function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
