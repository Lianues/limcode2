import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentRun, AgentRunSourceLink, AgentRunTargetLink, RunDeliveryPolicy } from '../components';
import { activeDeliveryPolicyForRun, defaultAgentForConversation, runFinalModelText, runSource } from '../queries';
import { spawnAgentRun } from '../bundles';
import { InFlight } from '../../chat/components';
import { spawnUserMessage, UserMessageBundle } from '../../chat/bundles';
import { ToolCall, ToolState } from '../../tools/components';
import { spawnToolCallEvent, ToolCallEventBundle } from '../../tools/bundles';
import { transitionToolState } from '../../tools/state';

const DeliveringRunsQuery = defineQuery({
  name: 'DeliveringRuns',
  all: [AgentRun],
  read: [AgentRun, AgentRunSourceLink, AgentRunTargetLink, RunDeliveryPolicy, ToolCall, ToolState],
  write: [AgentRun, ToolState],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunDeliverySystem = defineSystem({
  name: 'AgentRunDeliverySystem',
  access: {
    queries: [DeliveringRunsQuery],
    bundles: [UserMessageBundle, ToolCallEventBundle]
  },
  run({ world, cmd }) {
    for (const runEntity of world.query(AgentRun)) {
      const run = world.get(runEntity, AgentRun);
      if (!run || run.status !== 'delivering') continue;
      const policy = activeDeliveryPolicyForRun(world, runEntity);
      const mode = policy?.mode ?? 'direct_reply';

      if (mode === 'tool_response') {
        const delivered = deliverToolResponse(world, cmd, runEntity);
        if (!delivered) continue;
      } else if (mode === 'notification') {
        deliverNotification(world, cmd, runEntity);
      }

      cmd.add(runEntity, AgentRun, { ...run, status: 'completed', updatedAt: Date.now() });
    }
  }
});

function deliverToolResponse(world: WorldReader, cmd: CommandSink, runEntity: Entity): boolean {
  const source = runSource(world, runEntity);
  const toolCallEntity = source?.sourceToolCall;
  if (toolCallEntity === undefined) return false;
  const call = world.get(toolCallEntity, ToolCall);
  const state = world.get(toolCallEntity, ToolState);
  if (!call || !state) return false;
  const text = runFinalModelText(world, runEntity);
  const result = { ok: true, result: text, runId: world.get(runEntity, AgentRun)?.id };
  const now = Date.now();
  cmd.add(toolCallEntity, ToolState, transitionToolState(state, 'success', { result, durationMs: Math.max(0, now - call.createdAt) }, now));
  cmd.remove(toolCallEntity, InFlight);
  spawnToolCallEvent(cmd, {
    toolCall: toolCallEntity,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs: Math.max(0, now - call.createdAt),
    payload: result
  });
  return true;
}

function deliverNotification(world: WorldReader, cmd: CommandSink, runEntity: Entity): void {
  const source = world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .find((candidate) => candidate?.run === runEntity);
  if (!source) return;
  const sourceConversation = source?.sourceConversation;
  if (sourceConversation === undefined) return;
  const text = runFinalModelText(world, runEntity);
  const runId = world.get(runEntity, AgentRun)?.id ?? String(runEntity);
  const message = spawnUserMessage(cmd, sourceConversation, `<task-notification>\n<task-id>${runId}</task-id>\n<type>agent_run</type>\n<status>completed</status>\n<result>${escapeXml(text)}</result>\n</task-notification>`);
  const agent = source.sourceAgent ?? defaultAgentForConversation(world, sourceConversation);
  if (agent !== undefined) {
    spawnAgentRun(cmd, {
      kind: 'notification',
      agent,
      conversation: sourceConversation,
      sourceKind: 'agentRun',
      sourceRun: runEntity,
      sourceConversation,
      sourceMessage: message,
      inputMessage: message,
      deliveryMode: 'direct_reply',
      includeTranscript: 'full'
    });
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
