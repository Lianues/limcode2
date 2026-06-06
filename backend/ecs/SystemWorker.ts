import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import { CommandBuffer, type EntityAllocator } from './CommandBuffer';
import { SnapshotWorldReader } from './SnapshotWorldReader';
import { serializeWorldCommands } from './WireCommand';
import { runClientSyncProjection, type ClientSyncWorkerInput } from '../world/clientSync/worker';
import type { System } from './types';
import type {
  DefaultSystemWorkerPayload,
  SystemWorkerFailure,
  SystemWorkerInput,
  SystemWorkerOutput,
  SystemWorkerRunRequest,
  SystemWorkerRunResponse
} from './SystemWorkerProtocol';

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

if (workerData !== undefined) {
  void run(workerData as SystemWorkerInput)
    .then((message) => parentPort?.postMessage(message))
    .catch((error) => parentPort?.postMessage(serializeError(error)));
} else {
  parentPort?.on('message', (message: unknown) => {
    if (!isRunRequest(message)) {
      parentPort?.postMessage({ type: 'result', id: -1, result: serializeError(new Error('Invalid system worker request.')) } satisfies SystemWorkerRunResponse);
      return;
    }

    void run(message.input)
      .then((result) => {
        parentPort?.postMessage({ type: 'result', id: message.id, result } satisfies SystemWorkerRunResponse);
      })
      .catch((error) => {
        parentPort?.postMessage({ type: 'result', id: message.id, result: serializeError(error) } satisfies SystemWorkerRunResponse);
      });
  });
}

async function run(input: SystemWorkerInput): Promise<SystemWorkerOutput> {
  if (input.modulePath === '@clientSync') {
    const buffer = new CommandBuffer(new WorkerEntityAllocator(input.entityBase ?? 0, input.entityLimit ?? 0));
    runClientSyncProjection(input.payload as ClientSyncWorkerInput, buffer);
    return { ok: true, commands: serializeWorldCommands(buffer.commands()) };
  }

  const system = loadSystem(input.modulePath, input.exportName);
  const payload = input.payload as DefaultSystemWorkerPayload;
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

function serializeError(error: unknown): SystemWorkerFailure {
  if (error instanceof Error) {
    return { ok: false, error: error.message, stack: error.stack };
  }
  return { ok: false, error: String(error) };
}

function isRunRequest(value: unknown): value is SystemWorkerRunRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'run'
    && typeof record.id === 'number'
    && typeof record.input === 'object'
    && record.input !== null;
}
