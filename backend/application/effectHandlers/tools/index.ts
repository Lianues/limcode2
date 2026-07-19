import { ToolEventType } from '../../../world/modules/tools/events';
import type { ToolStatePayload } from '../../../world/modules/tools/events';
import type { ToolResultOut, ToolRuntimeEvent } from '../../../world/modules/tools/registry';
import type { EffectHandlerRegistry } from '../registry';

export function registerToolEffectHandlers(registry: EffectHandlerRegistry): void {
  // 每个在途运行时工具调用一个 AbortController，供 tool.abort 尽力真中断（镜像 llm.abort 的做法）。
  const controllers = new Map<string, AbortController>();

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

    const controller = new AbortController();
    controllers.set(effect.toolCallId, controller);

    tool
      .execute(args, { fs: env.fs, command: env.command, workEnvironment: env.workEnvironment, storage: env.storage, skills: env.skills }, { toolCallId: effect.toolCallId, runId: effect.runId, conversationId: effect.conversationId, config: effect.config, settingsSnapshot: effect.settingsSnapshot, workEnvironment: effect.workEnvironment, workEnvironments: effect.workEnvironments, accessibleWorkEnvironments: effect.accessibleWorkEnvironments, signal: controller.signal, emit: emitRuntimeEvent, emitWorldEvent: emit })
      .then((result) => emitToolState(emit, toToolStatePayload(effect.toolCallId, result, Date.now() - startedAt)))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message }, durationMs: Date.now() - startedAt });
      })
      .finally(() => controllers.delete(effect.toolCallId));
  });

  registry.register('tool.abort', (effect) => {
    const controller = controllers.get(effect.toolCallId);
    if (!controller) return;
    controllers.delete(effect.toolCallId);
    controller.abort();
  });

  registry.register('tool.background', (effect, env) => {
    env.command.backgroundForeground(effect.toolCallId);
  });

  registry.register('tool.change.apply', (effect, env, emit) => {
    const startedAt = Date.now();
    env.fs
      .applyPendingFileChange(effect.proposal, {
        workEnvironment: effect.workEnvironment,
        accessibleWorkEnvironments: effect.accessibleWorkEnvironments,
        allowOutsideProjectPaths: effect.allowOutsideProjectPaths
      })
      .then((output) => {
        const durationMs = Date.now() - startedAt;
        const finalState = toToolStatePayload(effect.toolCallId, {
          ok: output.success,
          output,
          ...(output.kind === 'file_edit.result' && output.failed > 0 ? { status: 'warning' as const } : {})
        }, durationMs);
        emitToolState(emit, { toolCallId: effect.toolCallId, status: 'change_applied', result: finalState.result, durationMs });
        emitToolState(emit, finalState);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitToolState(emit, { toolCallId: effect.toolCallId, status: 'error', error: message, result: { error: message }, durationMs: Date.now() - startedAt });
      });
  });
}

function toToolStatePayload(toolCallId: string, result: ToolResultOut, durationMs: number): ToolStatePayload {
  const response = { ok: result.ok, output: result.output, ...(result.parts?.length ? { parts: result.parts } : {}) };
  if (result.ok) {
    if (result.status === 'awaiting_change_apply') {
      return { toolCallId, status: 'awaiting_change_apply', result: response, durationMs };
    }
    const status = result.status === 'warning' ? 'warning' : 'success';
    return { toolCallId, status, result: response, durationMs };
  }
  return { toolCallId, status: 'error', error: errorTextForToolOutput(result.output), result: response, durationMs };
}

function errorTextForToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output, null, 2); }
  catch { return String(output); }
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
