export interface ConversationContextLoadEffect {
  kind: 'conversation.context.load';
  conversationId: string;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'conversation.context.load': ConversationContextLoadEffect;
  }
}
