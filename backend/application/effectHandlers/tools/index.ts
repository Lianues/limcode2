import { ToolEventType } from '../../../world/modules/tools/events';
import type { EffectHandlerRegistry } from '../registry';

export function registerToolEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('tool.run', (effect, env, emit) => {
    const tool = env.tools.registry.find((candidate) => candidate.declaration.name === effect.name);
    if (!tool) {
      emit({ type: ToolEventType.Done, payload: { toolCallId: effect.toolCallId, ok: false, output: `Unknown tool: ${effect.name}` } });
      return;
    }

    let args: unknown;
    try {
      args = effect.argsJson ? JSON.parse(effect.argsJson) : {};
    } catch (error) {
      emit({ type: ToolEventType.Done, payload: { toolCallId: effect.toolCallId, ok: false, output: `Invalid args JSON: ${String(error)}` } });
      return;
    }

    tool
      .execute(args, { fs: env.fs, command: env.command })
      .then((result) => emit({ type: ToolEventType.Done, payload: { toolCallId: effect.toolCallId, ok: result.ok, output: result.output } }))
      .catch((error) => emit({ type: ToolEventType.Done, payload: { toolCallId: effect.toolCallId, ok: false, output: error instanceof Error ? error.message : String(error) } }));
  });
}
