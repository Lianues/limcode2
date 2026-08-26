export interface StorageConversationPersistEffect {
  kind: 'storage.conversation.persist';
  conversationId: string;
  reason: 'compression_complete';
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'storage.conversation.persist': StorageConversationPersistEffect;
  }
}
