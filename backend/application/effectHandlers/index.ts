import type { EffectHandlerRegistry } from './registry';
import { registerClientSyncEffectHandlers } from './clientSync';
import { registerLlmEffectHandlers } from './llm';
import { registerToolEffectHandlers } from './tools';
import { registerCheckpointEffectHandlers } from './checkpoint';

export { EffectHandlerRegistry } from './registry';

export function registerApplicationEffectHandlers(registry: EffectHandlerRegistry): void {
  registerLlmEffectHandlers(registry);
  registerToolEffectHandlers(registry);
  registerCheckpointEffectHandlers(registry);
  registerClientSyncEffectHandlers(registry);
}
