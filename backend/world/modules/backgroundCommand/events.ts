export const BackgroundCommandEventType = {
  Exited: 'backgroundCommand:exited'
} as const;

export interface BackgroundCommandExitedPayload {
  processId: string;
  toolName: 'shell' | 'bash';
  toolCallId?: string;
  runId?: string;
  conversationId?: string;
  command: string;
  cwd: string;
  status: 'exited' | 'killed';
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  droppedChars?: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'backgroundCommand:exited': BackgroundCommandExitedPayload;
  }
}
