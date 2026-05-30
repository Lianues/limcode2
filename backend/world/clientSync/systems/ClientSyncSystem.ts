import type { ClientState } from '../../../../shared/protocol';
import { defineSystem, type AccessDeclaration, type WorldReader, type WorldSnapshot } from '../../../ecs/types';
import { readEvents } from '../../events';
import type { ClientStateContributor } from '../contributors';
import { ClientSyncEventType } from '../events';
import { ClientStateContributorsKey, ClientSyncStateKey } from '../resources';

export const ClientSyncSystem = defineSystem({
  name: 'ClientSyncSystem',
  worker: {
    modulePath: '@clientSync',
    exportName: 'runClientSyncProjection',
    payload({ world, events, snapshot }) {
      const registry = world.getResource(ClientStateContributorsKey);
      const syncState = world.getResource(ClientSyncStateKey);
      return {
        snapshot: cloneWithoutContributorRegistry(snapshot),
        events,
        contributors: registry.descriptors(),
        previousState: syncState.lastState,
        version: syncState.version,
        wantSnapshot: events.some((event) => event.type === ClientSyncEventType.Resync)
      };
    }
  },
  access(world) {
    const projectionReads = world.tryGetResource(ClientStateContributorsKey)?.reads() ?? emptyReads();
    return {
      reads: projectionReads,
      resources: {
        read: [ClientStateContributorsKey, ClientSyncStateKey],
        write: [ClientSyncStateKey],
        mutationMode: 'update'
      },
      events: { read: [ClientSyncEventType.Resync] },
      effects: { emit: ['client.snapshot', 'client.patch'] }
    };
  },
  run(ctx) {
    // 主线程 fallback：正常应用会通过 worker 跑；测试或 parallelWorkers=false 时仍可工作。
    const { world, cmd } = ctx;
    const registry = world.getResource(ClientStateContributorsKey);
    const syncState = world.getResource(ClientSyncStateKey);
    const contributors = registry.list();
    const next = projectClientState(world, contributors);
    const wantSnapshot = readEvents(ctx, ClientSyncEventType.Resync).length > 0;

    if (syncState.lastState === null || wantSnapshot) {
      const version = syncState.version + 1;
      cmd.setResource(ClientSyncStateKey, { version, lastState: next });
      cmd.effect({ kind: 'client.snapshot', version, state: next });
      return;
    }

    const prev = syncState.lastState;
    const patches = contributors.flatMap((contributor) => contributor.diff?.(prev, next) ?? []);
    if (patches.length > 0) {
      const version = syncState.version + 1;
      cmd.setResource(ClientSyncStateKey, { version, lastState: next });
      cmd.effect({ kind: 'client.patch', version, patches });
    }
  }
});

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
}

function projectClientState(world: WorldReader, contributors: ClientStateContributor[]): ClientState {
  const state: ClientState = { agents: [], sessions: [], agentConversationLinks: [], messages: [], toolCalls: [] };
  for (const contributor of contributors) {
    if (!contributor.project) {
      throw new Error(`ClientState contributor "${contributor.key}" does not provide a main-thread projector.`);
    }
    Object.assign(state, contributor.project(world));
  }
  return state;
}

function cloneWithoutContributorRegistry(snapshot: WorldSnapshot): WorldSnapshot {
  return {
    ...snapshot,
    resources: snapshot.resources.filter((resource) => resource.name !== ClientStateContributorsKey.name)
  };
}
