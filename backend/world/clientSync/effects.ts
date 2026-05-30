import type { ClientPatchOp, ClientState } from '../../../shared/protocol';

export interface ClientSnapshotEffect {
  kind: 'client.snapshot';
  streamId: string;
  /** 当前 state stream 的顺序号，不是协议版本。 */
  streamSeq: number;
  state: ClientState;
}

export interface ClientPatchEffect {
  kind: 'client.patch';
  streamId: string;
  /** 当前 state stream 的顺序号，不是协议版本。 */
  streamSeq: number;
  patches: ClientPatchOp[];
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'client.snapshot': ClientSnapshotEffect;
    'client.patch': ClientPatchEffect;
  }
}
