import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { WorkerEvent, WorkerFailure } from './shared/types.js';
import type { WorkerRequestBody, WorkerResponse, WorkerResponseData } from './worker/protocol.js';
import { isWorkerResponse } from './worker/protocol.js';

interface PendingRequest {
  resolve: (value: WorkerResponseData) => void;
  reject: (error: WorkerClientError) => void;
  abort?: () => void;
}

export class WorkerClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly workerStack?: string,
  ) {
    super(message);
    this.name = 'WorkerClientError';
  }
}

export class WorkerClient implements vscode.Disposable {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventEmitter = new vscode.EventEmitter<WorkerEvent>();
  private readonly crashEmitter = new vscode.EventEmitter<string>();
  private disposed = false;
  private exited = false;

  readonly onDidReceiveEvent = this.eventEmitter.event;
  readonly onDidCrash = this.crashEmitter.event;

  constructor(extensionUri: vscode.Uri) {
    const workerPath = vscode.Uri.joinPath(extensionUri, 'dist', 'worker.cjs').fsPath;
    this.worker = new Worker(workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: 768,
        maxYoungGenerationSizeMb: 128,
        stackSizeMb: 8,
      },
    });
    this.worker.on('message', (value: unknown) => this.handleMessage(value));
    this.worker.on('error', (error) => this.handleExit(`Worker error: ${error.message}`, error));
    this.worker.on('exit', (code) => {
      if (!this.disposed) this.handleExit(`The preview worker stopped unexpectedly (exit code ${code}).`);
      else this.exited = true;
    });
  }

  request(
    body: WorkerRequestBody,
    options: { requestId?: string; signal?: AbortSignal } = {},
  ): Promise<WorkerResponseData> {
    if (this.disposed || this.exited) return Promise.reject(new WorkerClientError('WORKER_UNAVAILABLE', 'The preview worker is unavailable. Refresh the editor.'));
    const requestId = options.requestId ?? randomUUID();
    if (this.pending.has(requestId)) return Promise.reject(new WorkerClientError('DUPLICATE_REQUEST', `A request named ${requestId} is already running.`));
    if (options.signal?.aborted) return Promise.reject(new WorkerClientError('CANCELLED', 'The operation was cancelled.'));

    return new Promise<WorkerResponseData>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (options.signal) {
        const onAbort = (): void => {
          // Reject locally first so a busy worker cannot leave the webview
          // waiting for an IPC round-trip. The worker still receives the
          // cancellation request and will discard the operation at its next
          // cooperative yield.
          this.rejectPending(requestId, new WorkerClientError('CANCELLED', 'The operation was cancelled.'));
          void this.cancel(requestId);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.abort = () => options.signal?.removeEventListener('abort', onAbort);
      }
      this.pending.set(requestId, pending);
      try {
        this.worker.postMessage({ ...body, requestId });
      } catch (error) {
        this.pending.delete(requestId);
        pending.abort?.();
        reject(new WorkerClientError('WORKER_UNAVAILABLE', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  async cancel(targetRequestId: string): Promise<void> {
    this.rejectPending(targetRequestId, new WorkerClientError('CANCELLED', 'The operation was cancelled.'));
    if (this.disposed || this.exited) return;
    try {
      await this.request({ type: 'cancel', sessionId: '', targetRequestId });
    } catch {
      // The target may have completed while cancellation was being sent.
    }
  }

  private handleMessage(value: unknown): void {
    if (!isWorkerResponse(value)) return;
    const message: WorkerResponse = value;
    if (message.type === 'event') {
      this.eventEmitter.fire(message.data);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.abort?.();
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new WorkerClientError(message.error.code, message.error.message, message.error.stack));
  }

  private rejectPending(requestId: string, error: WorkerClientError): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.abort?.();
    pending.reject(error);
  }

  private handleExit(message: string, cause?: Error): void {
    if (this.exited) return;
    this.exited = true;
    const failure = new WorkerClientError('WORKER_CRASHED', message, cause?.stack);
    for (const pending of this.pending.values()) {
      pending.abort?.();
      pending.reject(failure);
    }
    this.pending.clear();
    this.crashEmitter.fire(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const failure = new WorkerClientError('WORKER_DISPOSED', 'The preview was closed.');
    for (const pending of this.pending.values()) {
      pending.abort?.();
      pending.reject(failure);
    }
    this.pending.clear();
    void this.worker.terminate();
    this.eventEmitter.dispose();
    this.crashEmitter.dispose();
  }
}

export function workerFailure(error: unknown): WorkerFailure {
  if (error instanceof WorkerClientError) {
    return { code: error.code, message: error.message, ...(error.workerStack ? { stack: error.workerStack } : {}) };
  }
  if (error instanceof Error) return { code: 'INTERNAL_ERROR', message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  return { code: 'INTERNAL_ERROR', message: String(error) };
}
