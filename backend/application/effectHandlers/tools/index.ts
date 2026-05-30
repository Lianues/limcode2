import { ToolEventType } from '../../../world/modules/tools/events';
import type { ToolStatePayload } from '../../../world/modules/tools/events';
import type { ToolResultOut } from '../../../world/modules/tools/registry';
import type { EffectHandlerRegistry } from '../registry';

export function registerToolEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('tool.run', (effect, env, emit) => {
    const tool = env.tools.registry.find((candidate) => candidate.declaration.name === effect.name);
    if (!tool) {
      emitToolState(emit, {
        toolCallId: effect.toolCallId,
        status: 'error',
        error: `Unknown tool: ${effect.name}`,
        result: { error: `Unknown tool: ${effect.name}` }
      });
      return;
    }

    let args: unknown;
    try {
      args = effect.argsJson ? JSON.parse(effect.argsJson) : {};
    } catch (error) {
      const message = `Invalid args JSON: ${String(error)}`;
      emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message } });
      return;
    }

    tool
      .execute(args, { fs: env.fs, command: env.command })
      .then((result) => emitToolState(emit, toToolStatePayload(effect.toolCallId, result)))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message } });
      });
  });
}

function toToolStatePayload(toolCallId: string, result: ToolResultOut): ToolStatePayload {
  const response = { ok: result.ok, output: result.output };
  if (result.ok) {
    return { toolCallId, status: 'success', result: response };
  }
  return { toolCallId, status: 'error', error: result.output, result: response };
}

function emitToolState(emit: (event: { type: string; payload: ToolStatePayload }) => void, payload: ToolStatePayload): void {
  emit({ type: ToolEventType.State, payload });
}
