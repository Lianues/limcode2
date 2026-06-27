import type { ClientPatchOp, ClientState, LlmTransientNoticePayload } from '../../../shared/protocol';

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

export interface ClientTransientNoticeEffect {
  kind: 'client.transientNotice';
  streamId: string;
  payload: LlmTransientNoticePayload;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'client.snapshot': ClientSnapshotEffect;
    'client.patch': ClientPatchEffect;
    'client.transientNotice': ClientTransientNoticeEffect;
  }
}
