import type { AccessDeclaration, ComponentType, ResourceKey, WorldReader } from '../../ecs/types';

export interface VersionedProjectionContributor<TSlice extends object> {
  readonly key: string;
  readonly reads?: AccessDeclaration;
  readonly project?: (world: WorldReader) => TSlice;
}

export interface ProjectionContributorState<TSlice extends object> {
  readonly clock: string;
  readonly slice: TSlice;
}

export interface ProjectionCache<TSlice extends object> {
  readonly projectionClock: string;
  readonly contributorStates: Record<string, ProjectionContributorState<TSlice>>;
}

export interface ProjectionResult<TState extends object, TSlice extends object> extends ProjectionCache<TSlice> {
  readonly state: TState;
  readonly changed: boolean;
}

export function projectStateWithCache<TState extends object, TSlice extends object>(
  world: WorldReader,
  contributors: readonly VersionedProjectionContributor<TSlice>[],
  previous: ProjectionCache<TSlice>,
  emptyState: () => TState,
  label: string
): ProjectionResult<TState, TSlice> {
  const state = emptyState();
  const contributorStates: Record<string, ProjectionContributorState<TSlice>> = {};
  let changed = false;

  for (const contributor of contributors) {
    const clock = contributorClock(world, contributor);
    const cached = previous.contributorStates[contributor.key];
    let slice: TSlice;

    if (cached && cached.clock === clock) {
      slice = cached.slice;
    } else {
      if (!contributor.project) throw new Error(`${label} contributor "${contributor.key}" does not provide a projector.`);
      slice = contributor.project(world);
      changed = true;
    }

    contributorStates[contributor.key] = { clock, slice };
    Object.assign(state, slice);
  }

  const projectionClock = contributors
    .map((contributor) => `${contributor.key}=${contributorStates[contributor.key]?.clock ?? ''}`)
    .join('||');

  if (projectionClock !== previous.projectionClock) changed = true;

  return { state, projectionClock, contributorStates, changed };
}

export function contributorClock<TSlice extends object>(world: WorldReader, contributor: VersionedProjectionContributor<TSlice>): string {
  return [
    ...componentClockParts(world, contributor.reads?.components ?? []),
    ...resourceClockParts(world, contributor.reads?.resources ?? [])
  ].join('|');
}

function componentClockParts(world: WorldReader, components: readonly ComponentType<unknown>[]): string[] {
  return uniqueByName(components)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((component) => `c:${component.name}:${world.componentVersion(component)}`);
}

function resourceClockParts(world: WorldReader, resources: readonly ResourceKey<unknown>[]): string[] {
  return uniqueByName(resources)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((resource) => `r:${resource.name}:${world.resourceVersion(resource)}`);
}

function uniqueByName<T extends { readonly name: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.name, item])).values()];
}
