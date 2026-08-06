import type {
  DocumentKind,
  JsonEditOperation,
  JsonSourceLocation,
  JsonlPageResult,
  JsonlQueryResult,
  JsonlQuerySpec,
  JsonlValueChunkResult,
  PreviewSettings,
  SessionOpenResult,
  SourceSignature,
  TreeChildrenResult,
  TreeSearchResult,
  WorkerEvent,
  WorkerFailure,
} from '../shared/types.js';

export type WorkerSource =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string; signature: SourceSignature };

export type WorkerRequestBody =
  | {
      type: 'session/open';
      sessionId: string;
      kind: DocumentKind;
      source: WorkerSource;
      settings: PreviewSettings;
      cacheDirectory: string;
      cacheKey: string;
    }
  | { type: 'session/reloadText'; sessionId: string; text: string }
  | { type: 'session/applyEdit'; sessionId: string; edit: JsonEditOperation }
  | { type: 'session/close'; sessionId: string }
  | { type: 'json/children'; sessionId: string; pointer: string; offset: number; limit: number }
  | { type: 'json/childPage'; sessionId: string; parentPointer: string; childPointer: string; limit: number }
  | { type: 'json/search'; sessionId: string; query: string; limit: number }
  | { type: 'json/location'; sessionId: string; pointer: string }
  | { type: 'jsonl/page'; sessionId: string; queryId: string; offset: number; limit: number }
  | { type: 'jsonl/query'; sessionId: string; queryId: string; spec: JsonlQuerySpec }
  | { type: 'jsonl/treeChildren'; sessionId: string; physicalLine: number; pointer: string; offset: number; limit: number }
  | { type: 'jsonl/valueChunk'; sessionId: string; physicalLine: number; pointer: string; offset: number; limit: number }
  | { type: 'cancel'; sessionId: string; targetRequestId: string }
  | { type: 'cache/prune'; cacheDirectory: string; maxBytes: number }
  | { type: 'diagnostics/memory' };

export type WorkerRequest = WorkerRequestBody & { requestId: string };

export type WorkerResponseData =
  | SessionOpenResult
  | TreeChildrenResult
  | TreeSearchResult
  | JsonSourceLocation
  | JsonlPageResult
  | JsonlQueryResult
  | JsonlValueChunkResult
  | { closed: true }
  | { reloaded: true; result: SessionOpenResult }
  | { edited: true; text: string; result: SessionOpenResult }
  | { cancelled: true }
  | { removedBytes: number }
  | { rss: number; heapUsed: number; heapTotal: number; external: number };

export type WorkerResponse =
  | { type: 'response'; requestId: string; ok: true; data: WorkerResponseData }
  | { type: 'response'; requestId: string; ok: false; error: WorkerFailure }
  | { type: 'event'; data: WorkerEvent };

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown };
  return candidate.type === 'response' || candidate.type === 'event';
}
