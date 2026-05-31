export interface ToolRunEffect {
  kind: 'tool.run';
  toolCallId: string;
  name: string;
  argsJson: string;
  runId?: string;
  conversationId?: string;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'tool.run': ToolRunEffect;
  }
}
