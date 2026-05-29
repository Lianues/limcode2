import { BridgeMessageType } from '../../../../shared/protocol';
import type { EffectHandlerRegistry } from '../registry';

export function registerClientSyncBindings(registry: EffectHandlerRegistry): void {
  registry.register('client.snapshot', (effect, env) => {
    env.webview.post({ type: BridgeMessageType.ClientSnapshot, payload: { version: effect.version, state: effect.state } });
  });

  registry.register('client.patch', (effect, env) => {
    if (effect.patches.length > 0) {
      env.webview.post({ type: BridgeMessageType.ClientPatch, payload: { version: effect.version, patches: effect.patches } });
    }
  });
}
