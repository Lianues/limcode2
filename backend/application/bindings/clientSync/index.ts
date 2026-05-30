import {
  BridgeMessageType,
  GLOBAL_CLIENT_STATE_STREAM_ID,
  createMessageId
} from '../../../../shared/protocol';
import type { EffectHandlerRegistry } from '../registry';

export function registerClientSyncBindings(registry: EffectHandlerRegistry): void {
  registry.register('client.snapshot', (effect, env) => {
    env.webview.broadcast({
      id: createMessageId(),
      type: BridgeMessageType.ClientSnapshot,
      channel: 'state',
      scope: { kind: 'global' },
      payload: {
        streamId: GLOBAL_CLIENT_STATE_STREAM_ID,
        version: effect.version,
        state: effect.state
      }
    });
  });

  registry.register('client.patch', (effect, env) => {
    if (effect.patches.length > 0) {
      env.webview.broadcast({
        id: createMessageId(),
        type: BridgeMessageType.ClientPatch,
        channel: 'state',
        scope: { kind: 'global' },
        payload: {
          streamId: GLOBAL_CLIENT_STATE_STREAM_ID,
          version: effect.version,
          patches: effect.patches
        }
      });
    }
  });
}
