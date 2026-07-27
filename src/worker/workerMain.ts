import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { TextDecoder } from 'node:util';
import type { SessionOpenResult, WorkerEvent } from '../shared/types.js';
import { PreviewError, toWorkerFailure } from './errors.js';
import { JsonEngine } from './jsonEngine.js';
import { JsonlEngine } from './jsonlEngine.js';
import { applyDocumentEdit } from './editing.js';
import { computeFileSignature } from './lineIndex.js';
import type {
  WorkerRequest,
  WorkerRequestBody,
  WorkerResponse,
  WorkerResponseData,
  WorkerSource,
} from './protocol.js';

if (!parentPort) throw new Error('Fast JSON Viewer worker must run in a worker thread.');

interface JsonSession {
  kind: 'json';
  engine: JsonEngine;
  source: WorkerSource;
  settings: Extract<WorkerRequestBody, { type: 'session/open' }>['settings'];
  cacheDirectory: string;
  cacheKey: string;
}

interface JsonlSession {
  kind: 'jsonl';
  engine: JsonlEngine;
  source: WorkerSource;
  settings: Extract<WorkerRequestBody, { type: 'session/open' }>['settings'];
  cacheDirectory: string;
  cacheKey: string;
}

type Session = JsonSession | JsonlSession;

const sessions = new Map<string, Session>();
const cancelledRequests = new Set<string>();
const activeRequests = new Set<string>();

function post(message: WorkerResponse): void {
  parentPort!.postMessage(message);
}

function emit(event: WorkerEvent): void {
  post({ type: 'event', data: event });
  if (event.event === 'indexReady') {
    const session = sessions.get(event.sessionId);
    if (session) {
      const protectedPaths = new Set([
        join(session.cacheDirectory, `${session.cacheKey}.lines.idx`),
        join(session.cacheDirectory, `${session.cacheKey}.lines.meta.json`),
      ]);
      void pruneCache(session.cacheDirectory, session.settings.indexCacheBytes, protectedPaths).catch(() => undefined);
    }
  }
}

function cancelled(requestId: string): () => boolean {
  return () => cancelledRequests.has(requestId);
}

function getSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new PreviewError('SESSION_NOT_FOUND', 'The preview session no longer exists. Refresh the editor.');
  return session;
}

function getJsonSession(sessionId: string): JsonSession {
  const session = getSession(sessionId);
  if (session.kind !== 'json') throw new PreviewError('WRONG_DOCUMENT_KIND', 'This operation is only available for JSON documents.');
  return session;
}

function getJsonlSession(sessionId: string): JsonlSession {
  const session = getSession(sessionId);
  if (session.kind !== 'jsonl') throw new PreviewError('WRONG_DOCUMENT_KIND', 'This operation is only available for JSONL documents.');
  return session;
}

async function readStrictUtf8(source: WorkerSource): Promise<string> {
  if (source.type === 'text') return source.text;
  const signature = await computeFileSignature(source.path, source.signature);
  const bytes = await readFile(source.path);
  await computeFileSignature(source.path, signature);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PreviewError('INVALID_UTF8', error instanceof Error ? error.message : 'The file is not valid UTF-8.');
  }
}

async function closeSession(session: Session | undefined): Promise<void> {
  if (session?.kind === 'jsonl') await session.engine.close();
}

async function openSession(
  request: Extract<WorkerRequestBody, { type: 'session/open' }>,
  requestId: string,
): Promise<SessionOpenResult> {
  const previous = sessions.get(request.sessionId);
  sessions.delete(request.sessionId);
  await closeSession(previous);

  if (request.kind === 'json') {
    const engine = JsonEngine.parse(await readStrictUtf8(request.source), request.source.type === 'text');
    sessions.set(request.sessionId, {
      kind: 'json',
      engine,
      source: request.source,
      settings: request.settings,
      cacheDirectory: request.cacheDirectory,
      cacheKey: request.cacheKey,
    });
    return { kind: 'json', root: engine.summary(), parseMilliseconds: engine.parseMilliseconds };
  }

  const opened = await JsonlEngine.open(
    request.sessionId,
    request.source,
    request.settings,
    request.cacheDirectory,
    request.cacheKey,
    emit,
    cancelled(requestId),
  );
  sessions.set(request.sessionId, {
    kind: 'jsonl',
    engine: opened.engine,
    source: request.source,
    settings: request.settings,
    cacheDirectory: request.cacheDirectory,
    cacheKey: request.cacheKey,
  });
  return opened.result;
}

async function reloadText(sessionId: string, text: string, requestId: string): Promise<SessionOpenResult> {
  const previous = getSession(sessionId);
  if (previous.kind === 'json') {
    const engine = JsonEngine.parse(text, true);
    sessions.set(sessionId, { ...previous, engine, source: { type: 'text', text } });
    return { kind: 'json', root: engine.summary(), parseMilliseconds: engine.parseMilliseconds };
  }

  sessions.delete(sessionId);
  await previous.engine.close();
  const source: WorkerSource = { type: 'text', text };
  const opened = await JsonlEngine.open(
    sessionId,
    source,
    previous.settings,
    previous.cacheDirectory,
    previous.cacheKey,
    emit,
    cancelled(requestId),
  );
  sessions.set(sessionId, { ...previous, engine: opened.engine, source });
  return opened.result;
}

async function applyEdit(sessionId: string, edit: Parameters<typeof applyDocumentEdit>[2], requestId: string): Promise<WorkerResponseData> {
  const session = getSession(sessionId);
  if (session.source.type !== 'text') throw new PreviewError('READ_ONLY', 'Large files are read-only and cannot be edited.');
  const text = applyDocumentEdit(session.source.text, session.kind, edit);
  const editLimit = session.kind === 'jsonl'
    ? Math.min(session.settings.editableMaxBytes, 10 * 1024 * 1024)
    : session.settings.editableMaxBytes;
  if (Buffer.byteLength(text, 'utf8') > editLimit) {
    throw new PreviewError('EDIT_LIMIT', `The edited document would exceed the ${Math.round(editLimit / 1024 / 1024)} MB edit limit.`);
  }
  const result = await reloadText(sessionId, text, requestId);
  return { edited: true, text, result };
}

async function pruneCache(cacheDirectory: string, maximumBytes: number, protectedPaths: ReadonlySet<string> = new Set()): Promise<number> {
  let entries;
  try {
    entries = await readdir(cacheDirectory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw error;
  }

  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const path = join(cacheDirectory, entry.name);
    try {
      const details = await stat(path);
      return { path, size: details.size, used: Math.max(details.atimeMs, details.mtimeMs) };
    } catch {
      return undefined;
    }
  }));
  const existing = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
  const available = existing.filter((file) => !protectedPaths.has(file.path));
  // Protected files still count toward the cache budget; they are merely
  // skipped as deletion candidates while the current session uses them.
  let total = existing.reduce((sum, file) => sum + file.size, 0);
  let removedBytes = 0;
  available.sort((left, right) => left.used - right.used);
  for (const file of available) {
    if (total <= maximumBytes) break;
    try {
      await unlink(file.path);
      total -= file.size;
      removedBytes += file.size;
    } catch {
      // An active index can be locked on Windows; it will be considered next time.
    }
  }
  return removedBytes;
}

async function dispatch(request: WorkerRequest): Promise<WorkerResponseData> {
  switch (request.type) {
    case 'session/open':
      return openSession(request, request.requestId);
    case 'session/reloadText':
      return { reloaded: true, result: await reloadText(request.sessionId, request.text, request.requestId) };
    case 'session/applyEdit':
      return applyEdit(request.sessionId, request.edit, request.requestId);
    case 'session/close': {
      const session = sessions.get(request.sessionId);
      sessions.delete(request.sessionId);
      await closeSession(session);
      return { closed: true };
    }
    case 'json/children':
      return getJsonSession(request.sessionId).engine.children(request.pointer, request.offset, request.limit);
    case 'json/childPage':
      return getJsonSession(request.sessionId).engine.childPage(request.parentPointer, request.childPointer, request.limit);
    case 'json/search':
      return getJsonSession(request.sessionId).engine.search(request.query, request.limit, cancelled(request.requestId));
    case 'json/location':
      return getJsonSession(request.sessionId).engine.location(request.pointer);
    case 'jsonl/page':
      return getJsonlSession(request.sessionId).engine.page(request.queryId, request.offset, request.limit, cancelled(request.requestId));
    case 'jsonl/query':
      return getJsonlSession(request.sessionId).engine.query(request.queryId, request.spec, request.requestId, cancelled(request.requestId));
    case 'jsonl/treeChildren':
      return getJsonlSession(request.sessionId).engine.treeChildren(request.physicalLine, request.pointer, request.offset, request.limit, cancelled(request.requestId));
    case 'cancel':
      if (activeRequests.has(request.targetRequestId)) cancelledRequests.add(request.targetRequestId);
      return { cancelled: true };
    case 'cache/prune':
      return { removedBytes: await pruneCache(request.cacheDirectory, Math.max(0, request.maxBytes)) };
    case 'diagnostics/memory': {
      const memory = process.memoryUsage();
      return { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external };
    }
  }
}

parentPort.on('message', (value: unknown) => {
  const request = value as WorkerRequest;
  if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || typeof request.type !== 'string') return;
  if (request.type !== 'cancel') activeRequests.add(request.requestId);
  void dispatch(request).then(
    (data) => post({ type: 'response', requestId: request.requestId, ok: true, data }),
    (error: unknown) => post({ type: 'response', requestId: request.requestId, ok: false, error: toWorkerFailure(error) }),
  ).finally(() => {
    if (request.type !== 'cancel') {
      activeRequests.delete(request.requestId);
      cancelledRequests.delete(request.requestId);
    }
  });
});

async function shutdown(): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map(closeSession));
}

parentPort.on('close', () => void shutdown());
