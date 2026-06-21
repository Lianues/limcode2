import type {
  CompressionCreatePayload,
  CompressionDeletePayload,
  CompressionRegeneratePayload,
  CompressionTogglePayload,
  CompressionUpdatePayload
} from '../../../../shared/protocol';

export const CompressionEventType = {
  Create: 'compression:create',
  Delete: 'compression:delete',
  Update: 'compression:update',
  Regenerate: 'compression:regenerate',
  Disable: 'compression:disable',
  Enable: 'compression:enable'
} as const;

export type CompressionCreateEventPayload = CompressionCreatePayload;
export type CompressionDeleteEventPayload = CompressionDeletePayload;
export type CompressionUpdateEventPayload = CompressionUpdatePayload;
export type CompressionRegenerateEventPayload = CompressionRegeneratePayload;
export type CompressionToggleEventPayload = CompressionTogglePayload;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'compression:create': CompressionCreateEventPayload;
    'compression:delete': CompressionDeleteEventPayload;
    'compression:update': CompressionUpdateEventPayload;
    'compression:regenerate': CompressionRegenerateEventPayload;
    'compression:disable': CompressionToggleEventPayload;
    'compression:enable': CompressionToggleEventPayload;
  }
}
