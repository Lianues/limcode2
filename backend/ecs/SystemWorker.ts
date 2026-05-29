import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import { CommandBuffer, type EntityAllocator } from './CommandBuffer';
import { SnapshotWorldReader } from './SnapshotWorldReader';
import { serializeWorldCommands, type WireWorldCommand } from './WireCommand';
import { runClientSyncProjection, type ClientSyncWorkerInput } from '../world/clientSync/worker';
import type { System, SystemContext, WorldSnapshot } from './types';

interface WorkerInput {
  readonly modulePath: string;
  readonly exportName: string;
  readonly events?: SystemContext['events'];
  readonly entityBase?: number;
  readonly entityLimit?: number;
  readonly payload?: unknown;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly commands: readonly WireWorldCommand[];
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
  readonly stack?: string;
}

type WorkerOutput = WorkerSuccess | WorkerFailure;

class WorkerEntityAllocator implements EntityAllocator {
  private next = 0;

  public constructor(
    private readonly base: number,
    private readonly limit: number
  ) {}

  public reserveEntity(): number {
    if (this.limit <= 0) {
      throw new Error('This worker system did not declare spawn access but called cmd.spawn().');
    }
    if (this.next >= this.limit) {
      throw new Error(`Worker entity block exhausted: used ${this.next + 1}, limit ${this.limit}.`);
    }
    return this.base + this.next++;
  }
}

void run(workerData as WorkerInput)
  .then((message) => parentPort?.postMessage(message))
  .catch((error) => parentPort?.postMessage(serializeError(error)));

async function run(input: WorkerInput): Promise<WorkerOutput> {
  if (input.modulePath === '@clientSync') {
    const buffer = new CommandBuffer(new WorkerEntityAllocator(input.entityBase ?? 0, input.entityLimit ?? 0));
    runClientSyncProjection(input.payload as ClientSyncWorkerInput, buffer);
    return { ok: true, commands: serializeWorldCommands(buffer.commands()) };
  }

  const system = loadSystem(input.modulePath, input.exportName);
  const payload = input.payload as { snapshot: WorldSnapshot; events: SystemContext['events'] };
  const world = new SnapshotWorldReader(payload.snapshot);
  const allocator = new WorkerEntityAllocator(input.entityBase ?? 0, input.entityLimit ?? 0);
  const buffer = new CommandBuffer(allocator);

  system.run({ events: payload.events, world, cmd: buffer });
  return { ok: true, commands: serializeWorldCommands(buffer.commands()) };
}

function loadSystem(modulePath: string, exportName: string): System {
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, modulePath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(resolved) as Record<string, unknown>;
  const system = mod[exportName];
  if (!isSystem(system)) {
    throw new Error(`Worker export is not a System: ${modulePath}#${exportName}`);
  }
  return system;
}

function isSystem(value: unknown): value is System {
  return typeof value === 'object' && value !== null && typeof (value as { run?: unknown }).run === 'function';
}

function serializeError(error: unknown): WorkerFailure {
  if (error instanceof Error) {
    return { ok: false, error: error.message, stack: error.stack };
  }
  return { ok: false, error: String(error) };
}
