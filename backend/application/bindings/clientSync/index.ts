import {
  BridgeMessageType,
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationIdFromClientStateStreamId,
  createMessageId,
  type BridgeScope
} from '../../../../shared/protocol';
import type { EffectHandlerRegistry } from '../registry';

export function registerClientSyncBindings(registry: EffectHandlerRegistry): void {
  registry.register('client.snapshot', (effect, env) => {
    env.webview.broadcast({
      id: createMessageId(),
      type: BridgeMessageType.ClientSnapshot,
      channel: 'state',
      scope: scopeForStream(effect.streamId),
      payload: {
        streamId: effect.streamId,
        streamSeq: effect.streamSeq,
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
        scope: scopeForStream(effect.streamId),
        payload: {
          streamId: effect.streamId,
          streamSeq: effect.streamSeq,
          patches: effect.patches
        }
      });
    }
  });
}

function scopeForStream(streamId: string): BridgeScope {
  if (streamId === GLOBAL_CLIENT_STATE_STREAM_ID) return { kind: 'global' };
  const conversationId = conversationIdFromClientStateStreamId(streamId);
  if (conversationId) return { kind: 'conversation', id: conversationId };
  return { kind: 'global' };
}
