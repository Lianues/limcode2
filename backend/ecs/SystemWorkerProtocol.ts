import type { SystemContext, WorldSnapshot } from './types';
import type { WireWorldCommand } from './WireCommand';

export interface SystemWorkerInput {
  readonly modulePath: string;
  readonly exportName: string;
  readonly events?: SystemContext['events'];
  readonly entityBase?: number;
  readonly entityLimit?: number;
  readonly payload?: unknown;
}

export interface SystemWorkerSuccess {
  readonly ok: true;
  readonly commands: readonly WireWorldCommand[];
}

export interface SystemWorkerFailure {
  readonly ok: false;
  readonly error: string;
  readonly stack?: string;
}

export type SystemWorkerOutput = SystemWorkerSuccess | SystemWorkerFailure;

export interface SystemWorkerRunRequest {
  readonly type: 'run';
  readonly id: number;
  readonly input: SystemWorkerInput;
}

export interface SystemWorkerRunResponse {
  readonly type: 'result';
  readonly id: number;
  readonly result: SystemWorkerOutput;
}

export interface DefaultSystemWorkerPayload {
  readonly snapshot: WorldSnapshot;
  readonly events: SystemContext['events'];
}
