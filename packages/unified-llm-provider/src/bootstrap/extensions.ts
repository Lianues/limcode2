import { createBuiltinFormatRegistry, FormatRegistry } from '../registry/formats.js';
import { createBuiltinProviderRegistry, LLMProviderFactoryRegistry } from '../registry/providers.js';

export { FormatRegistry, LLMProviderFactoryRegistry };
export type { FormatAdapterFactory } from '../registry/formats.js';
export type { LLMProviderFactory } from '../registry/providers.js';

export interface BootstrapExtensionRegistry {
  formats: FormatRegistry;
  llmProviders: LLMProviderFactoryRegistry;
}

export function createBootstrapExtensionRegistry(): BootstrapExtensionRegistry {
  return {
    formats: createBuiltinFormatRegistry(),
    llmProviders: createBuiltinProviderRegistry(),
  };
}

export function createBuiltinRegistry(): BootstrapExtensionRegistry {
  return createBootstrapExtensionRegistry();
}
