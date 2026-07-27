import type { WorkerFailure } from '../shared/types.js';

export class PreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

export function toWorkerFailure(error: unknown): WorkerFailure {
  if (error instanceof PreviewError) {
    return { code: error.code, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { code: 'INTERNAL_ERROR', message: String(error) };
}
