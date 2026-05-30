import * as path from 'path';
import type { ClientPatchOp, ClientState } from '../../../shared/protocol';
import { CommandBuffer, type EntityAllocator } from '../../ecs/CommandBuffer';
import { SnapshotWorldReader } from '../../ecs/SnapshotWorldReader';
import type { SystemContext, WorldSnapshot } from '../../ecs/types';
import type { ClientStateContributorDescriptor, ClientStateDiffer, ClientStateProjector } from './contributors';
import { ClientSyncStateKey } from './resources';

export interface ClientSyncWorkerInput {
  readonly snapshot: WorldSnapshot;
  readonly events: SystemContext['events'];
  readonly contributors: readonly ClientStateContributorDescriptor[];
  readonly previousState: ClientState | null;
  readonly version: number;
  readonly wantSnapshot: boolean;
}

export function runClientSyncProjection(input: ClientSyncWorkerInput, cmd: CommandBuffer): void {
  const world = new SnapshotWorldReader(input.snapshot);
  const next = projectClientState(world, input.contributors);

  if (input.previousState === null || input.wantSnapshot) {
    const version = input.version + 1;
    cmd.setResource(ClientSyncStateKey, { version, lastState: next });
    cmd.effect({ kind: 'client.snapshot', version, state: next });
    return;
  }

  const patches = input.contributors.flatMap((contributor) => {
    const diff = loadDiffer(contributor);
    return diff?.(input.previousState!, next) ?? [];
  });

  if (patches.length > 0) {
    const version = input.version + 1;
    cmd.setResource(ClientSyncStateKey, { version, lastState: next });
    cmd.effect({ kind: 'client.patch', version, patches });
  }
}

export function projectClientState(world: SnapshotWorldReader, contributors: readonly ClientStateContributorDescriptor[]): ClientState {
  const state: ClientState = { agents: [], sessions: [], agentConversationLinks: [], messages: [], toolCalls: [] };
  for (const contributor of contributors) {
    Object.assign(state, loadProjector(contributor)(world));
  }
  return state;
}

function loadProjector(contributor: ClientStateContributorDescriptor): ClientStateProjector {
  const project = loadExport(contributor.worker.modulePath, contributor.worker.projectExport);
  if (typeof project !== 'function') {
    throw new Error(`ClientSync contributor "${contributor.key}" project export is not a function.`);
  }
  return project as ClientStateProjector;
}

function loadDiffer(contributor: ClientStateContributorDescriptor): ClientStateDiffer | undefined {
  if (!contributor.worker.diffExport) return undefined;
  const diff = loadExport(contributor.worker.modulePath, contributor.worker.diffExport);
  if (typeof diff !== 'function') {
    throw new Error(`ClientSync contributor "${contributor.key}" diff export is not a function.`);
  }
  return diff as ClientStateDiffer;
}

function loadExport(modulePath: string, exportName: string): unknown {
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, '../../ecs', modulePath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolved) as Record<string, unknown>;
  return mod[exportName];
}

export class NoopEntityAllocator implements EntityAllocator {
  public reserveEntity(): number {
    throw new Error('ClientSync projection must not spawn entities.');
  }
}
