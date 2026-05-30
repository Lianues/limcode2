import type { EffectHandlerRegistry } from './registry';
import { registerClientSyncEffectHandlers } from './clientSync';
import { registerLlmEffectHandlers } from './llm';
import { registerToolEffectHandlers } from './tools';

export { EffectHandlerRegistry } from './registry';

export function registerApplicationEffectHandlers(registry: EffectHandlerRegistry): void {
  registerLlmEffectHandlers(registry);
  registerToolEffectHandlers(registry);
  registerClientSyncEffectHandlers(registry);
}
