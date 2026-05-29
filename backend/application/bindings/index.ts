import type { EffectHandlerRegistry } from './registry';
import { registerClientSyncBindings } from './clientSync';
import { registerLlmBindings } from './llm';
import { registerToolBindings } from './tools';

export { EffectHandlerRegistry } from './registry';

export function registerApplicationBindings(registry: EffectHandlerRegistry): void {
  registerLlmBindings(registry);
  registerToolBindings(registry);
  registerClientSyncBindings(registry);
}
