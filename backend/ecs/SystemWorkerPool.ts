import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import type {
  SystemWorkerInput,
  SystemWorkerOutput,
  SystemWorkerRunRequest,
  SystemWorkerRunResponse
} from './SystemWorkerProtocol';

export interface SystemWorkerPoolOptions {
  readonly size?: number;
  readonly workerPath?: string;
}

interface PendingJob {
  readonly id: number;
  readonly input: SystemWorkerInput;
  readonly resolve: (result: SystemWorkerOutput) => void;
  readonly reject: (error: unknown) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  current?: PendingJob;
  closed: boolean;
}

export class SystemWorkerPool {
  private readonly maxSize: number;
  private readonly workerPath: string;
  private readonly slots = new Set<WorkerSlot>();
  private readonly idle: WorkerSlot[] = [];
  private readonly queue: PendingJob[] = [];
  private disposed = false;
  private nextId = 1;

  public constructor(options: SystemWorkerPoolOptions = {}) {
    this.maxSize = Math.max(1, Math.floor(options.size ?? defaultWorkerPoolSize()));
    this.workerPath = options.workerPath ?? path.join(__dirname, 'SystemWorker.js');
  }

  public run(input: SystemWorkerInput): Promise<SystemWorkerOutput> {
    if (this.disposed) {
      return Promise.reject(new Error('SystemWorkerPool has been disposed.'));
    }

    return new Promise<SystemWorkerOutput>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, input, resolve, reject });
      this.drain();
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const error = new Error('SystemWorkerPool has been disposed.');
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(error);
    }
    this.idle.length = 0;

    for (const slot of this.slots) {
      slot.closed = true;
      slot.current?.reject(error);
      slot.current = undefined;
      void slot.worker.terminate();
    }
    this.slots.clear();
  }

  private drain(): void {
    if (this.disposed) return;

    while (this.queue.length > 0) {
      const slot = this.takeIdleSlot() ?? this.createSlotIfAvailable();
      if (!slot) return;

      const job = this.queue.shift();
      if (!job) return;
      this.start(slot, job);
    }
  }

  private takeIdleSlot(): WorkerSlot | undefined {
    while (this.idle.length > 0) {
      const slot = this.idle.pop();
      if (slot && !slot.closed && !slot.current) return slot;
    }
    return undefined;
  }

  private createSlotIfAvailable(): WorkerSlot | undefined {
    if (this.slots.size >= this.maxSize) return undefined;

    const slot: WorkerSlot = {
      worker: new Worker(this.workerPath),
      closed: false
    };

    slot.worker.on('message', (message: unknown) => this.handleMessage(slot, message));
    slot.worker.on('error', (error) => this.failSlot(slot, error));
    slot.worker.on('exit', (code) => {
      if (slot.closed) return;
      const reason = code === 0
        ? new Error('System worker exited unexpectedly.')
        : new Error(`System worker exited with code ${code}.`);
      this.failSlot(slot, reason);
    });

    this.slots.add(slot);
    return slot;
  }

  private start(slot: WorkerSlot, job: PendingJob): void {
    slot.current = job;
    const request: SystemWorkerRunRequest = { type: 'run', id: job.id, input: job.input };
    try {
      slot.worker.postMessage(request);
    } catch (error) {
      slot.current = undefined;
      job.reject(error);
      this.releaseSlot(slot);
      this.drain();
    }
  }

  private handleMessage(slot: WorkerSlot, message: unknown): void {
    if (!isRunResponse(message)) {
      this.failSlot(slot, new Error('System worker sent an invalid response.'));
      return;
    }

    const job = slot.current;
    if (!job || job.id !== message.id) {
      this.failSlot(slot, new Error(`System worker response id mismatch: ${message.id}.`));
      return;
    }

    slot.current = undefined;
    job.resolve(message.result);
    this.releaseSlot(slot);
    this.drain();
  }

  private releaseSlot(slot: WorkerSlot): void {
    if (this.disposed || slot.closed) return;
    this.idle.push(slot);
  }

  private failSlot(slot: WorkerSlot, error: unknown): void {
    if (slot.closed) return;

    slot.closed = true;
    this.removeIdleSlot(slot);
    this.slots.delete(slot);

    const job = slot.current;
    slot.current = undefined;
    job?.reject(error);

    void slot.worker.terminate();
    this.drain();
  }

  private removeIdleSlot(slot: WorkerSlot): void {
    const index = this.idle.indexOf(slot);
    if (index >= 0) this.idle.splice(index, 1);
  }
}

function defaultWorkerPoolSize(): number {
  const cpuCount = Math.max(1, os.cpus().length || 1);
  return Math.max(1, Math.min(4, cpuCount - 1 || 1));
}

function isRunResponse(value: unknown): value is SystemWorkerRunResponse {
  if (!isRecord(value)) return false;
  return value.type === 'result'
    && typeof value.id === 'number'
    && isWorkerOutput(value.result);
}

function isWorkerOutput(value: unknown): value is SystemWorkerOutput {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok === true) return Array.isArray(value.commands);
  return typeof value.error === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
