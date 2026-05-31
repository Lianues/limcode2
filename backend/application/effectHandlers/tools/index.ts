import { ToolEventType } from '../../../world/modules/tools/events';
import type { ToolStatePayload } from '../../../world/modules/tools/events';
import type { ToolResultOut, ToolRuntimeEvent } from '../../../world/modules/tools/registry';
import type { EffectHandlerRegistry } from '../registry';

export function registerToolEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('tool.run', (effect, env, emit) => {
    const tool = env.tools.registry.find((candidate) => candidate.declaration.name === effect.name);
    if (!tool || tool.execution !== 'runtime') {
      emitToolState(emit, {
        toolCallId: effect.toolCallId,
        status: 'error',
        error: `Unknown runtime tool: ${effect.name}`,
        durationMs: 0,
        result: { error: `Unknown runtime tool: ${effect.name}` }
      });
      return;
    }

    let args: unknown;
    try {
      args = effect.argsJson ? JSON.parse(effect.argsJson) : {};
    } catch (error) {
      const message = `Invalid args JSON: ${String(error)}`;
      emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message }, durationMs: 0 });
      return;
    }

    const startedAt = Date.now();
    const emitRuntimeEvent = (event: ToolRuntimeEvent): void => {
      emitToolState(emit, toRunningToolStatePayload(effect.toolCallId, event));
    };

    tool
      .execute(args, { fs: env.fs, command: env.command }, { toolCallId: effect.toolCallId, runId: effect.runId, conversationId: effect.conversationId, emit: emitRuntimeEvent })
      .then((result) => emitToolState(emit, toToolStatePayload(effect.toolCallId, result, Date.now() - startedAt)))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message }, durationMs: Date.now() - startedAt });
      });
  });
}

function toToolStatePayload(toolCallId: string, result: ToolResultOut, durationMs: number): ToolStatePayload {
  const response = { ok: result.ok, output: result.output };
  if (result.ok) {
    return { toolCallId, status: 'success', result: response, durationMs };
  }
  return { toolCallId, status: 'error', error: result.output, result: response, durationMs };
}

function toRunningToolStatePayload(toolCallId: string, event: ToolRuntimeEvent): ToolStatePayload {
  const progress = event.progress ?? event.payload;
  return {
    toolCallId,
    status: 'executing',
    eventKind: event.kind,
    ...(event.delta !== undefined ? { delta: event.delta } : {}),
    ...(progress !== undefined ? { progress } : {})
  };
}

function emitToolState(emit: (event: { type: string; payload: ToolStatePayload }) => void, payload: ToolStatePayload): void {
  emit({ type: ToolEventType.State, payload });
}
