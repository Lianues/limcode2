import type { ClientPatchOp, ClientState } from '../../../shared/protocol';

export interface ClientSnapshotEffect {
  kind: 'client.snapshot';
  version: number;
  state: ClientState;
}

export interface ClientPatchEffect {
  kind: 'client.patch';
  version: number;
  patches: ClientPatchOp[];
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'client.snapshot': ClientSnapshotEffect;
    'client.patch': ClientPatchEffect;
  }
}
