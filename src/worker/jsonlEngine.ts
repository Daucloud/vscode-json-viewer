import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { pathFromPointer, valueAtPointer } from '../shared/pointer.js';
import type {
  IndexReadyEvent,
  JsonlOpenResult,
  JsonlPageResult,
  JsonlQueryResult,
  JsonlQuerySpec,
  JsonlRow,
  JsonlValueChunkResult,
  PreviewSettings,
  QueryProgressEvent,
  SourceSignature,
  TreeChildrenResult,
  WorkerEvent,
} from '../shared/types.js';
import type { WorkerSource } from './protocol.js';
import { PreviewError } from './errors.js';
import { collectUnsafeIntegers, JsonEngine, jsonLiteralAtPointer } from './jsonEngine.js';
import { compactSortValue, compareSortValues, flattenForTable, matchesStructuredFilter } from './filter.js';
import { computeFileSignature, DiskLineIndex, type LineRecord } from './lineIndex.js';
import { ResultIndex, ResultIndexWriter, type ResultRecord } from './resultIndex.js';

const INITIAL_READ_BYTES = 4 * 1024 * 1024;
const READ_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_ROW_RAW_CHARS = 16_384;
const MAX_PAGE_MESSAGE_BYTES = 900 * 1024;
// The page contains up to 200 rows. Capping a pathological row keeps both the
// session/open response and regular page responses below the 1 MiB IPC budget.
const MAX_CELL_CHARS = 4_096;
const MAX_ROW_MESSAGE_BYTES = 3_500;
const MAX_INITIAL_PAYLOAD_BYTES = 700 * 1024;
const RESULT_PREFIX = 'query-';
const TREE_CACHE_MAX_ENTRIES = 8;
const TREE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_VALUE_CHUNK_CHARS = 128 * 1024;
const VALUE_CACHE_MAX_ENTRIES = 4;
// The normal JSONL parse limit is 16 MB. Keep one default-limit record hot for
// chunked viewing without allowing a custom 256 MB line limit to pin an equally
// large UTF-16 string in the worker.
const VALUE_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
const EMPTY_EXACT_NUMBERS: ReadonlyMap<string, string> = new Map();

interface FileSource {
  type: 'file';
  path: string;
  signature: SourceSignature;
  handle: FileHandle;
}

interface TextSource {
  type: 'text';
  bytes: Uint8Array;
}

type ActiveSource = FileSource | TextSource;

interface ScannedLine {
  physicalLine: number;
  start: number;
  contentLength: number;
  eolLength: 0 | 1 | 2;
  raw?: Uint8Array;
  tooLarge: boolean;
}

interface SortableRecord extends ResultRecord {
  value: unknown;
  exact?: string;
}

interface TreeCacheEntry {
  engine: JsonEngine;
  sourceBytes: number;
}

interface ValueCacheEntry {
  literal: string;
  chars: number;
}

type EventSink = (event: WorkerEvent) => void;

function sourceChunks(source: ActiveSource): AsyncIterable<Uint8Array> {
  if (source.type === 'file') return createReadStream(source.path, { highWaterMark: 4 * 1024 * 1024 });
  return (async function* (): AsyncIterable<Uint8Array> { yield source.bytes; })();
}

async function scanLines(
  source: ActiveSource,
  maximumLineBytes: number,
  onLine: (line: ScannedLine) => void | Promise<void>,
  onProgress: (bytes: number, records: number) => void,
  cancelled: () => boolean,
): Promise<number> {
  let carry = Buffer.alloc(0);
  let carryStart = 0;
  let scanned = 0;
  let records = 0;
  let oversized = false;
  let oversizedStart = 0;
  let oversizedPreview = Buffer.alloc(0);
  let lastProgress = performance.now();
  let previousByte: number | undefined;

  const emit = (start: number, raw: Uint8Array | undefined, contentLength: number, eolLength: 0 | 1 | 2, tooLarge: boolean): void | Promise<void> => {
    records++;
    return onLine({ physicalLine: records, start, contentLength, eolLength, ...(raw ? { raw } : {}), tooLarge });
  };

  for await (const incoming of sourceChunks(source)) {
    if (cancelled()) throw new PreviewError('CANCELLED', 'Operation cancelled.');
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);
    let chunkCursor = 0;

    if (oversized) {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) {
        scanned += chunk.length;
        if (chunk.length > 0) previousByte = chunk[chunk.length - 1];
        onProgress(scanned, records);
        continue;
      }
      const before = newline > 0 ? chunk[newline - 1] : previousByte;
      const eolLength: 1 | 2 = before === 0x0d ? 2 : 1;
      const contentLength = scanned + newline - oversizedStart - (eolLength === 2 ? 1 : 0);
      const pending = emit(oversizedStart, oversizedPreview, Math.max(0, contentLength), eolLength, true);
      if (pending) await pending;
      oversized = false;
      oversizedPreview = Buffer.alloc(0);
      chunkCursor = newline + 1;
      carryStart = scanned + chunkCursor;
    }

    const remaining = chunk.subarray(chunkCursor);
    const data = carry.length > 0 ? Buffer.concat([carry, remaining]) : remaining;
    const dataStart = carry.length > 0 ? carryStart : scanned + chunkCursor;
    let cursor = 0;
    while (cursor < data.length) {
      const newline = data.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const hasCarriageReturn = newline > cursor && data[newline - 1] === 0x0d;
      const rawEnd = hasCarriageReturn ? newline - 1 : newline;
      const raw = data.subarray(cursor, rawEnd);
      const tooLarge = raw.length > maximumLineBytes;
      const pending = emit(dataStart + cursor, tooLarge ? raw.subarray(0, 4096) : raw, raw.length, hasCarriageReturn ? 2 : 1, tooLarge);
      if (pending) await pending;
      cursor = newline + 1;
      if ((records & 4095) === 0 && cancelled()) throw new PreviewError('CANCELLED', 'Operation cancelled.');
    }

    const trailing = data.subarray(cursor);
    if (trailing.length > maximumLineBytes) {
      oversized = true;
      oversizedStart = dataStart + cursor;
      oversizedPreview = Buffer.from(trailing.subarray(0, 4096));
      carry = Buffer.alloc(0);
    } else {
      carry = Buffer.from(trailing);
      carryStart = dataStart + cursor;
    }
    scanned += chunk.length;
    if (chunk.length > 0) previousByte = chunk[chunk.length - 1];
    const now = performance.now();
    if (now - lastProgress >= 100) {
      onProgress(scanned, records);
      lastProgress = now;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  if (oversized) {
    const pending = emit(oversizedStart, oversizedPreview, scanned - oversizedStart, 0, true);
    if (pending) await pending;
  } else if (carry.length > 0) {
    const pending = emit(carryStart, carry, carry.length, 0, false);
    if (pending) await pending;
  }
  onProgress(scanned, records);
  return records;
}

function hasQuery(spec: JsonlQuerySpec): boolean {
  return Boolean(spec.text || spec.filter || spec.sort);
}

function validateQueryPointers(spec: JsonlQuerySpec): void {
  try {
    if (spec.filter) pathFromPointer(spec.filter.pointer);
    if (spec.sort) pathFromPointer(spec.sort.pointer);
  } catch (error) {
    throw new PreviewError('INVALID_POINTER', error instanceof Error ? error.message : 'Enter a valid JSON Pointer.');
  }
}

function serializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : UTF8_ENCODER.encode(encoded).byteLength;
}

function safeQueryText(raw: string, spec: JsonlQuerySpec, normalizedQuery?: string): boolean {
  if (!spec.text) return true;
  return spec.caseSensitive
    ? raw.includes(spec.text)
    : raw.toLowerCase().includes(normalizedQuery ?? spec.text.toLowerCase());
}

function shortenCell(value: string, maximum = MAX_CELL_CHARS): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

/**
 * Fit one table row under a small per-row budget. The source record remains
 * available through “Open source”; only its inline table representation is
 * shortened. Normal records take the zero-copy fast path above.
 */
function fitRowMessage(row: JsonlRow): JsonlRow {
  if (serializedBytes(row) <= MAX_ROW_MESSAGE_BYTES) return row;

  const diagnostic = row.diagnostic
    ? { ...row.diagnostic, message: shortenCell(row.diagnostic.message, 512) }
    : undefined;
  const base: JsonlRow = {
    resultIndex: row.resultIndex,
    physicalLine: row.physicalLine,
    status: row.status,
    cells: {},
    raw: shortenCell(row.raw, 256),
    rawTruncated: true,
    ...(diagnostic ? { diagnostic } : {}),
  };
  const cells: JsonlRow['cells'] = {};
  for (const [key, value] of Object.entries(row.cells)) {
    const compactValue = typeof value === 'string' ? shortenCell(value, 256) : value;
    const candidate: JsonlRow = { ...base, cells: { ...cells, [key]: compactValue } };
    if (serializedBytes(candidate) > MAX_ROW_MESSAGE_BYTES) break;
    cells[key] = compactValue;
  }
  const result: JsonlRow = { ...base, cells };
  if (serializedBytes(result) <= MAX_ROW_MESSAGE_BYTES) return result;

  // Extremely long property names can consume the budget even after values
  // are shortened. Return a minimal row rather than an oversized message.
  return {
    resultIndex: row.resultIndex,
    physicalLine: row.physicalLine,
    status: row.status,
    cells: {},
    raw: '',
    rawTruncated: true,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export class JsonlEngine {
  private source!: ActiveSource;
  private sourceBytes = 0;
  private index: DiskLineIndex | undefined;
  private indexPromise?: Promise<DiskLineIndex>;
  private indexError?: unknown;
  private initialRows: JsonlRow[] = [];
  private sampledRows = 0;
  private readonly fields: string[] = [];
  private readonly fieldSet = new Set<string>();
  private readonly results = new Map<string, ResultIndex>();
  private readonly activeResultPaths = new Set<string>();
  private readonly treeCache = new Map<number, TreeCacheEntry>();
  private treeCacheBytes = 0;
  private readonly valueCache = new Map<string, ValueCacheEntry>();
  private valueCacheChars = 0;
  private readWindow?: { start: number; bytes: Uint8Array };
  private closed = false;
  private sourceInvalid = false;
  private queryGeneration = 0;
  private sourcePollTimer: NodeJS.Timeout | undefined;
  private sourcePollInFlight = false;

  private constructor(
    readonly sessionId: string,
    private readonly settings: PreviewSettings,
    private readonly cacheDirectory: string,
    private readonly cacheKey: string,
    private readonly emitEvent: EventSink,
  ) {}

  static async open(
    sessionId: string,
    source: WorkerSource,
    settings: PreviewSettings,
    cacheDirectory: string,
    cacheKey: string,
    emitEvent: EventSink,
    cancelled: () => boolean,
  ): Promise<{ engine: JsonlEngine; result: JsonlOpenResult }> {
    const engine = new JsonlEngine(sessionId, settings, cacheDirectory, cacheKey, emitEvent);
    const result = await engine.initialize(source, cancelled);
    return { engine, result };
  }

  private async initialize(source: WorkerSource, cancelled: () => boolean): Promise<JsonlOpenResult> {
    await mkdir(this.cacheDirectory, { recursive: true });
    if (source.type === 'file') {
      const signature = await computeFileSignature(source.path, source.signature);
      this.source = { type: 'file', path: source.path, signature, handle: await open(source.path, 'r') };
      this.sourceBytes = signature.size;
      this.startSourceMonitor();
    } else {
      const bytes = new TextEncoder().encode(source.text);
      this.source = { type: 'text', bytes };
      this.sourceBytes = bytes.byteLength;
    }

    await this.loadInitialRows(cancelled);
    await this.assertSourceUnchanged();
    if (this.source.type === 'file') {
      const indexPath = join(this.cacheDirectory, `${this.cacheKey}.lines.idx`);
      const metadataPath = join(this.cacheDirectory, `${this.cacheKey}.lines.meta.json`);
      const cached = await DiskLineIndex.tryLoad(indexPath, metadataPath, this.source.signature);
      if (cached) {
        this.index = cached;
        await this.discoverFieldsFromIndex(cancelled);
        return {
          kind: 'jsonl',
          fields: [...this.fields],
          initialRows: this.initialRows,
          indexReady: true,
          recordCount: cached.lineCount,
          indexMilliseconds: 0,
        };
      }
      this.startBackgroundIndex(indexPath, metadataPath, cancelled);
    } else {
      const token = randomUUID();
      const indexPath = join(this.cacheDirectory, `${token}.session.idx`);
      const metadataPath = join(this.cacheDirectory, `${token}.session.meta.json`);
      const started = performance.now();
      this.index = await DiskLineIndex.buildBuffer(this.source.bytes, indexPath, metadataPath, () => undefined, cancelled);
      await this.discoverFieldsFromIndex(cancelled);
      return {
        kind: 'jsonl',
        fields: [...this.fields],
        initialRows: this.initialRows,
        indexReady: true,
        recordCount: this.index.lineCount,
        indexMilliseconds: performance.now() - started,
      };
    }

    return { kind: 'jsonl', fields: [...this.fields], initialRows: this.initialRows, indexReady: false };
  }

  /**
   * A desktop file watcher normally invalidates the document from the
   * extension host. Remote workspace providers do not always surface a
   * watcher event, so keep a very small edge-fingerprint monitor in the
   * worker as a second line of defense. It never reads the complete source.
   */
  private startSourceMonitor(): void {
    if (this.source.type !== 'file' || this.sourcePollTimer) return;
    this.sourcePollTimer = setInterval(() => {
      if (this.closed || this.sourceInvalid || this.sourcePollInFlight || this.source.type !== 'file') return;
      this.sourcePollInFlight = true;
      const source = this.source;
      void computeFileSignature(source.path, source.signature).then((signature) => {
        if (!this.closed && !this.sourceInvalid && this.source === source) this.source = { ...source, signature };
      }).catch((error: unknown) => {
        if (this.closed || this.sourceInvalid) return;
        this.sourceInvalid = true;
        this.queryGeneration++;
        this.emitEvent({
          event: 'warning',
          sessionId: this.sessionId,
          code: 'SOURCE_CHANGED',
          message: error instanceof Error ? error.message : 'The source file changed. Refresh the viewer.',
        });
      }).finally(() => {
        this.sourcePollInFlight = false;
      });
    }, 500);
    this.sourcePollTimer.unref?.();
  }

  private startBackgroundIndex(indexPath: string, metadataPath: string, cancelled: () => boolean): void {
    if (this.source.type !== 'file') return;
    const source = this.source;
    const started = performance.now();
    this.indexPromise = DiskLineIndex.buildFile(
      source.path,
      indexPath,
      metadataPath,
      source.signature,
      (scannedBytes, records) => this.emitEvent({
        event: 'progress', sessionId: this.sessionId, task: 'index', scannedBytes, totalBytes: this.sourceBytes, records,
      }),
      () => this.closed || this.sourceInvalid || cancelled(),
    );
    void this.indexPromise.then(async (index) => {
      if (this.closed) {
        await index.close();
        return;
      }
      this.index = index;
      await this.assertSourceUnchanged();
      await this.discoverFieldsFromIndex(() => this.closed);
      await this.assertSourceUnchanged();
      const event: IndexReadyEvent = {
        event: 'indexReady', sessionId: this.sessionId, recordCount: index.lineCount, fields: [...this.fields], indexMilliseconds: performance.now() - started,
      };
      this.emitEvent(event);
    }).catch(async (error: unknown) => {
      // A source change or a failed build must never leave a stale index
      // available to subsequent page/query requests.
      const stale = this.index;
      this.index = undefined;
      if (stale) await stale.close().catch(() => undefined);
      await Promise.all([unlink(indexPath).catch(() => undefined), unlink(metadataPath).catch(() => undefined)]);
      this.indexError = error;
      if (!this.closed) {
        const sourceChanged = this.sourceInvalid || (error instanceof PreviewError && error.code === 'SOURCE_CHANGED');
        this.emitEvent({
          event: 'warning',
          sessionId: this.sessionId,
          code: sourceChanged ? 'SOURCE_CHANGED' : 'INDEX_FAILED',
          message: sourceChanged ? 'The source file changed. Refresh the viewer before continuing.' : error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async awaitIndex(cancelled?: () => boolean): Promise<DiskLineIndex> {
    if (cancelled?.()) throw new PreviewError('CANCELLED', 'Operation cancelled.');
    if (this.index) return this.index;
    if (this.indexError) throw this.indexError;
    if (!this.indexPromise) throw new PreviewError('INDEX_UNAVAILABLE', 'The line index is unavailable.');
    if (!cancelled) {
      const index = await this.indexPromise;
      this.index = index;
      return index;
    }
    let timeout: NodeJS.Timeout | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      const poll = (): void => {
        if (cancelled()) {
          reject(new PreviewError('CANCELLED', 'Operation cancelled.'));
          return;
        }
        timeout = setTimeout(poll, 25);
      };
      poll();
    });
    let index: DiskLineIndex;
    try {
      index = await Promise.race([this.indexPromise, cancellation]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    this.index = index;
    return index;
  }

  private async loadInitialRows(cancelled: () => boolean): Promise<void> {
    const readLength = Math.min(this.sourceBytes, Math.max(INITIAL_READ_BYTES, Math.min(this.settings.maxLineBytes + 2, 32 * 1024 * 1024)));
    let bytes: Uint8Array;
    if (this.source.type === 'text') bytes = this.source.bytes.subarray(0, readLength);
    else {
      const buffer = Buffer.alloc(readLength);
      const result = await this.source.handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, result.bytesRead);
    }
    this.readWindow = { start: 0, bytes };
    const records: LineRecord[] = [];
    let lineStart = 0;
    let physicalLine = 0;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cursor = 0;
    const wanted = Math.max(this.settings.pageSize, this.settings.schemaSampleRows);
    while (cursor < buffer.length && records.length < wanted) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const carriage = newline > cursor && buffer[newline - 1] === 0x0d;
      physicalLine++;
      records.push({ physicalLine, start: lineStart, contentLength: newline - cursor - (carriage ? 1 : 0), eolLength: carriage ? 2 : 1 });
      cursor = newline + 1;
      lineStart = cursor;
    }
    if (records.length < wanted && cursor < buffer.length && buffer.length === this.sourceBytes) {
      physicalLine++;
      records.push({ physicalLine, start: lineStart, contentLength: buffer.length - cursor, eolLength: 0 });
    } else if (records.length === 0 && buffer.length > this.settings.maxLineBytes) {
      records.push({ physicalLine: 1, start: 0, contentLength: buffer.length, eolLength: 0 });
    }
    const rows: JsonlRow[] = [];
    for (let index = 0; index < records.length; index++) {
      if (cancelled()) throw new PreviewError('CANCELLED', 'Opening cancelled.');
      const row = await this.readRow(records[index]!, index + 1, true);
      if (index < this.settings.pageSize) rows.push(row);
    }
    this.sampledRows = Math.max(this.sampledRows, records.length);
    const fittedRows: JsonlRow[] = [];
    let initialPayloadBytes = serializedBytes({ fields: this.fields, rows: [] });
    for (const row of rows) {
      const fitted = fitRowMessage(row);
      const rowBytes = serializedBytes(fitted) + (fittedRows.length > 0 ? 1 : 0);
      if (fittedRows.length > 0 && initialPayloadBytes + rowBytes > MAX_INITIAL_PAYLOAD_BYTES) break;
      fittedRows.push(fitted);
      initialPayloadBytes += rowBytes;
    }
    this.initialRows = fittedRows;
  }

  private addFields(cells: Readonly<Record<string, unknown>>): void {
    for (const field of Object.keys(cells)) {
      if (field.length > 256 || this.fieldSet.has(field) || this.fields.length >= 200) continue;
      this.fieldSet.add(field);
      this.fields.push(field);
    }
  }

  private async discoverFieldsFromIndex(cancelled: () => boolean): Promise<void> {
    const index = await this.awaitIndex();
    const count = Math.min(index.lineCount, this.settings.schemaSampleRows);
    for (let position = Math.min(this.sampledRows, count); position < count && this.fields.length < 200; position++) {
      if ((position & 127) === 0 && cancelled()) return;
      const record = await index.get(position);
      await this.readRow(record, position + 1, true);
      this.sampledRows = position + 1;
    }
  }

  private async assertSourceUnchanged(): Promise<void> {
    if (this.source.type !== 'file') return;
    if (this.sourceInvalid) throw new PreviewError('SOURCE_CHANGED', 'The source file changed. Refresh the viewer before continuing.');
    try {
      // A stat-only check misses editors that replace bytes in place while
      // preserving size and timestamp. Reuse the same edge fingerprint used by
      // the persistent index so every page/query observes a consistent source.
      const signature = await computeFileSignature(this.source.path, this.source.signature);
      this.source = { ...this.source, signature };
    } catch (error) {
      this.sourceInvalid = true;
      throw error;
    }
  }

  /**
   * Return files that must not be evicted while this session is alive.  The
   * cache pruner runs globally in the worker, so protecting only the index
   * that just finished could otherwise remove another open viewer's query or
   * line index underneath its file handle.
   */
  cachePaths(): ReadonlySet<string> {
    const paths = new Set<string>();
    if (this.source.type === 'file') {
      paths.add(join(this.cacheDirectory, `${this.cacheKey}.lines.idx`));
      paths.add(join(this.cacheDirectory, `${this.cacheKey}.lines.meta.json`));
    }
    for (const result of this.results.values()) paths.add(result.path);
    for (const path of this.activeResultPaths) paths.add(path);
    return paths;
  }

  private async bytes(start: number, length: number): Promise<Uint8Array> {
    if (this.source.type === 'text') return this.source.bytes.subarray(start, start + length);
    const existing = this.readWindow;
    if (existing && start >= existing.start && start + length <= existing.start + existing.bytes.byteLength) {
      return existing.bytes.subarray(start - existing.start, start - existing.start + length);
    }
    const readLength = Math.min(this.sourceBytes - start, Math.max(length, READ_WINDOW_BYTES));
    const buffer = Buffer.alloc(readLength);
    const result = await this.source.handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, result.bytesRead);
    this.readWindow = { start, bytes };
    return bytes.subarray(0, Math.min(length, bytes.length));
  }

  private async recordText(physicalLine: number, cancelled: () => boolean): Promise<{ raw: string; sourceBytes: number }> {
    if (!Number.isSafeInteger(physicalLine) || physicalLine < 1) {
      throw new PreviewError('LINE_NOT_FOUND', 'Select a valid JSONL record.');
    }
    const index = await this.awaitIndex(() => this.sourceInvalid || cancelled());
    if (physicalLine > index.lineCount) throw new PreviewError('LINE_NOT_FOUND', `Line ${physicalLine} does not exist.`);
    if (cancelled()) throw new PreviewError('CANCELLED', 'Value request cancelled.');
    const record = await index.get(physicalLine - 1);
    if (record.contentLength > this.settings.maxLineBytes) {
      throw new PreviewError('LINE_TOO_LARGE', 'This record is too large for the tree inspector.');
    }
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(await this.bytes(record.start, record.contentLength));
    } catch (error) {
      throw new PreviewError('INVALID_UTF8', error instanceof Error ? error.message : 'This record is not valid UTF-8.');
    }
    if (physicalLine === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (cancelled()) throw new PreviewError('CANCELLED', 'Value request cancelled.');
    return { raw, sourceBytes: record.contentLength };
  }

  private async treeForLine(physicalLine: number, cancelled: () => boolean): Promise<JsonEngine> {
    const cached = this.treeCache.get(physicalLine);
    if (cached) {
      // Promote the entry to the MRU end of the insertion-ordered map.
      this.treeCache.delete(physicalLine);
      this.treeCache.set(physicalLine, cached);
      return cached.engine;
    }

    const record = await this.recordText(physicalLine, cancelled);
    const tree = JsonEngine.parse(record.raw);
    // Do not retain a single record larger than the whole cache budget;
    // keeping it transient is safer than pinning a 100+ MB object graph.
    if (record.sourceBytes <= TREE_CACHE_MAX_BYTES) {
      const entry = { engine: tree, sourceBytes: record.sourceBytes };
      this.treeCache.set(physicalLine, entry);
      this.treeCacheBytes += entry.sourceBytes;
      while ((this.treeCache.size > TREE_CACHE_MAX_ENTRIES || this.treeCacheBytes > TREE_CACHE_MAX_BYTES) && this.treeCache.size > 1) {
        const oldestKey = this.treeCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.treeCache.get(oldestKey);
        this.treeCache.delete(oldestKey);
        this.treeCacheBytes -= oldest?.sourceBytes ?? 0;
      }
    }
    return tree;
  }

  private cachedValueLiteral(key: string): string | undefined {
    const cached = this.valueCache.get(key);
    if (!cached) return undefined;
    this.valueCache.delete(key);
    this.valueCache.set(key, cached);
    return cached.literal;
  }

  private rememberValueLiteral(key: string, literal: string): boolean {
    if (literal.length > VALUE_CACHE_MAX_CHARS) return false;
    const previous = this.valueCache.get(key);
    if (previous) {
      this.valueCache.delete(key);
      this.valueCacheChars -= previous.chars;
    }
    const entry = { literal, chars: literal.length };
    this.valueCache.set(key, entry);
    this.valueCacheChars += entry.chars;
    while ((this.valueCache.size > VALUE_CACHE_MAX_ENTRIES || this.valueCacheChars > VALUE_CACHE_MAX_CHARS) && this.valueCache.size > 1) {
      const oldestKey = this.valueCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.valueCache.get(oldestKey);
      this.valueCache.delete(oldestKey);
      this.valueCacheChars -= oldest?.chars ?? 0;
    }
    return true;
  }

  private async lineContainsText(
    start: number,
    length: number,
    query: string,
    caseSensitive: boolean,
    cancelled: () => boolean,
  ): Promise<boolean> {
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();
    if (!normalizedQuery) return true;
    const decoder = new TextDecoder('utf-8');
    const chunkBytes = 1024 * 1024;
    // Preserve enough decoded text to find a match split across read chunks.
    const overlap = Math.min(Math.max(normalizedQuery.length + 16, 64), 1024 * 1024);
    let carry = '';
    let cursor = 0;
    while (cursor < length) {
      if (cancelled()) throw new PreviewError('CANCELLED', 'Query cancelled.');
      const source = await this.bytes(start + cursor, Math.min(chunkBytes, length - cursor));
      if (source.byteLength === 0) break;
      cursor += source.byteLength;
      const decoded = decoder.decode(source, { stream: cursor < length });
      const candidate = `${carry}${decoded}`;
      const searchable = caseSensitive ? candidate : candidate.toLowerCase();
      if (searchable.includes(normalizedQuery)) return true;
      carry = candidate.slice(-overlap);
      if ((cursor & ((8 * chunkBytes) - 1)) === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return false;
  }

  private async readRow(record: LineRecord, resultIndex: number, collectFields: boolean): Promise<JsonlRow> {
    if (record.contentLength === 0) {
      return {
        resultIndex, physicalLine: record.physicalLine, status: 'empty', cells: {}, raw: '',
        diagnostic: { code: 'EMPTY_LINE', message: 'Empty JSONL record.', column: 1 },
      };
    }
    if (record.contentLength > this.settings.maxLineBytes) {
      const preview = new TextDecoder().decode(await this.bytes(record.start, Math.min(record.contentLength, 4096)));
      return {
        resultIndex, physicalLine: record.physicalLine, status: 'tooLarge', cells: {}, raw: `${preview}…`, rawTruncated: true,
        diagnostic: { code: 'LINE_TOO_LARGE', message: `Record exceeds the ${Math.round(this.settings.maxLineBytes / 1024 / 1024)} MB parsing limit.`, column: 1 },
      };
    }
    const source = await this.bytes(record.start, record.contentLength);
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch (error) {
      return {
        resultIndex, physicalLine: record.physicalLine, status: 'invalid', cells: {}, raw: new TextDecoder().decode(source.subarray(0, 4096)),
        diagnostic: { code: 'INVALID_UTF8', message: error instanceof Error ? error.message : String(error), column: 1 },
      };
    }
    if (record.physicalLine === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const rawTruncated = raw.length > MAX_ROW_RAW_CHARS;
    try {
      const value = JSON.parse(raw) as unknown;
      const exactNumbers = collectUnsafeIntegers(raw);
      const cells = flattenForTable(value, exactNumbers);
      if (collectFields) this.addFields(cells);
      return {
        resultIndex,
        physicalLine: record.physicalLine,
        status: 'valid',
        cells,
        raw: rawTruncated ? `${raw.slice(0, MAX_ROW_RAW_CHARS)}…` : raw,
        ...(rawTruncated ? { rawTruncated: true } : {}),
      };
    } catch (error) {
      const position = /position (\d+)/.exec(error instanceof Error ? error.message : '')?.[1];
      return {
        resultIndex,
        physicalLine: record.physicalLine,
        status: 'invalid',
        cells: {},
        raw: rawTruncated ? `${raw.slice(0, MAX_ROW_RAW_CHARS)}…` : raw,
        ...(rawTruncated ? { rawTruncated: true } : {}),
        diagnostic: { code: 'INVALID_JSON', message: error instanceof Error ? error.message : String(error), column: Number(position ?? 0) + 1 },
      };
    }
  }

  async page(queryId: string, offset: number, requestedLimit: number, cancelled: () => boolean = () => false): Promise<JsonlPageResult> {
    await this.assertSourceUnchanged();
    const pageCancelled = (): boolean => this.sourceInvalid || cancelled();
    const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    const limit = Math.min(this.settings.pageSize, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : this.settings.pageSize));
    if (queryId === 'default' && !this.index && safeOffset < this.initialRows.length && safeOffset + limit <= this.initialRows.length) {
      return { queryId, offset: safeOffset, total: this.initialRows.length, rows: this.initialRows.slice(safeOffset, safeOffset + limit) };
    }
    const index = await this.awaitIndex(pageCancelled);
    const records: ResultRecord[] = [];
    let total: number;
    if (queryId === 'default') {
      total = index.lineCount;
      for (let position = safeOffset; position < Math.min(total, safeOffset + limit); position++) {
        if ((position & 31) === 0 && pageCancelled()) throw new PreviewError('CANCELLED', 'Page request cancelled.');
        const line = await index.get(position);
        records.push({ physicalLine: line.physicalLine, sourceStart: line.start });
      }
    } else {
      const result = this.results.get(queryId);
      if (!result) throw new PreviewError('QUERY_NOT_FOUND', 'The query result expired. Run the query again.');
      total = result.count;
      records.push(...await result.page(safeOffset, limit));
    }
    const rows: JsonlRow[] = [];
    let messageBytes = 0;
    for (let position = 0; position < records.length; position++) {
      if ((position & 15) === 0 && pageCancelled()) throw new PreviewError('CANCELLED', 'Page request cancelled.');
      const record = await index.get(records[position]!.physicalLine - 1);
      const row = fitRowMessage(await this.readRow(record, safeOffset + position + 1, false));
      const size = serializedBytes(row);
      if (rows.length > 0 && messageBytes + size > MAX_PAGE_MESSAGE_BYTES) break;
      rows.push(row);
      messageBytes += size;
    }
    await this.assertSourceUnchanged();
    return { queryId, offset: safeOffset, total, rows };
  }

  async query(queryId: string, spec: JsonlQuerySpec, requestId: string, cancelled: () => boolean): Promise<JsonlQueryResult> {
    const generation = ++this.queryGeneration;
    const queryCancelled = (): boolean => this.closed || this.sourceInvalid || generation !== this.queryGeneration || cancelled();
    validateQueryPointers(spec);
    const index = await this.awaitIndex(queryCancelled);
    await this.assertSourceUnchanged();
    if (!hasQuery(spec)) return { queryId: 'default', scannedRows: 0, matchedRows: index.lineCount, elapsedMs: 0 };
    if (spec.sort && index.lineCount > this.settings.sortMaxRows && !spec.filter && !spec.text) {
      throw new PreviewError('SORT_LIMIT', `Global field sorting is limited to ${this.settings.sortMaxRows.toLocaleString()} records. Add a filter first.`);
    }
    const existing = this.results.get(queryId);
    if (existing) {
      await existing.close();
      this.results.delete(queryId);
    }
    const resultPath = join(this.cacheDirectory, `${RESULT_PREFIX}${this.sessionId}-${randomUUID()}.bin`);
    const writer = await ResultIndexWriter.create(resultPath);
    this.activeResultPaths.add(resultPath);
    const sortable: SortableRecord[] | undefined = spec.sort ? [] : undefined;
    const started = performance.now();
    let matches = 0;
    let scannedRows = 0;
    const normalizedTextQuery = spec.text && !spec.caseSensitive ? spec.text.toLowerCase() : undefined;
    const strictDecoder = new TextDecoder('utf-8', { fatal: true });
    try {
      await scanLines(
        this.source,
        this.settings.maxLineBytes,
        (line) => {
          scannedRows = line.physicalLine;
          if (line.tooLarge) {
            if (!spec.text || spec.filter || spec.sort) return;
            return (async (): Promise<void> => {
                if (!await this.lineContainsText(line.start, line.contentLength, spec.text!, Boolean(spec.caseSensitive), queryCancelled)) return;
              matches++;
              const flush = writer.append({ physicalLine: line.physicalLine, sourceStart: line.start });
              if (flush) await flush;
            })();
          }
          if (!line.raw) return;
          let raw: string;
          try { raw = strictDecoder.decode(line.raw); }
          catch { return; }
          if (line.physicalLine === 1 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
          if (!safeQueryText(raw, spec, normalizedTextQuery)) return;
          let value: unknown;
          let exactNumbers = EMPTY_EXACT_NUMBERS;
          if (spec.filter || spec.sort) {
            try {
              value = JSON.parse(raw) as unknown;
              const targets = new Set<string>();
              if (spec.filter?.op === 'compare' && spec.filter.value.kind === 'number') targets.add(spec.filter.pointer);
              const sortValue = spec.sort ? valueAtPointer(value, spec.sort.pointer) : undefined;
              if (spec.sort && typeof sortValue === 'number') targets.add(spec.sort.pointer);
              if (targets.size === 1) exactNumbers = collectUnsafeIntegers(raw, targets.values().next().value as string);
              else if (targets.size > 1) exactNumbers = collectUnsafeIntegers(raw);
            } catch {
              return;
            }
            if (!matchesStructuredFilter(value, spec.filter, exactNumbers)) return;
          }
          matches++;
          const record: ResultRecord = { physicalLine: line.physicalLine, sourceStart: line.start };
          if (sortable && spec.sort) {
            if (sortable.length >= this.settings.sortMaxRows) {
              throw new PreviewError('SORT_LIMIT', `The filtered result still exceeds the ${this.settings.sortMaxRows.toLocaleString()}-record sorting limit. Narrow the filter and try again.`);
            }
            const exactValue = exactNumbers.get(spec.sort.pointer);
            sortable.push({
              ...record,
              value: compactSortValue(valueAtPointer(value, spec.sort.pointer)),
              ...(exactValue !== undefined ? { exact: exactValue } : {}),
            });
          } else {
            return writer.append(record);
          }
          return undefined;
        },
        (scannedBytes, records) => {
          const event: QueryProgressEvent = {
            event: 'progress', sessionId: this.sessionId, task: 'query', requestId, scannedBytes, totalBytes: this.sourceBytes, records, matches,
          };
          this.emitEvent(event);
        },
        queryCancelled,
      );
      if (sortable && spec.sort) {
        const direction = spec.sort.direction === 'asc' ? 1 : -1;
        sortable.sort((left, right) => direction * (compareSortValues(left.value, right.value, left.exact, right.exact) || left.physicalLine - right.physicalLine));
        for (let position = 0; position < sortable.length; position++) {
          if ((position & 4095) === 0 && queryCancelled()) throw new PreviewError('CANCELLED', 'Query cancelled.');
          const item = sortable[position]!;
          const flush = writer.append(item);
          if (flush) await flush;
        }
      }
      if (queryCancelled()) throw new PreviewError('CANCELLED', 'Query cancelled.');
      await this.assertSourceUnchanged();
      const result = await writer.finish();
      this.activeResultPaths.delete(resultPath);
      this.results.set(queryId, result);
      while (this.results.size > 8) {
        const oldest = this.results.entries().next().value as [string, ResultIndex] | undefined;
        if (!oldest) break;
        this.results.delete(oldest[0]);
        await oldest[1].close();
      }
      return { queryId, scannedRows, matchedRows: result.count, elapsedMs: performance.now() - started };
    } catch (error) {
      this.activeResultPaths.delete(resultPath);
      await writer.abort();
      throw error;
    }
  }

  async treeChildren(physicalLine: number, pointer: string, offset: number, limit: number, cancelled: () => boolean = () => false): Promise<TreeChildrenResult> {
    await this.assertSourceUnchanged();
    const tree = await this.treeForLine(physicalLine, cancelled);
    const result = tree.children(pointer, offset, limit);
    await this.assertSourceUnchanged();
    return result;
  }

  async valueChunk(
    physicalLine: number,
    pointer: string,
    offset: number,
    requestedLimit: number,
    cancelled: () => boolean = () => false,
  ): Promise<JsonlValueChunkResult> {
    await this.assertSourceUnchanged();
    const key = `${physicalLine}\0${pointer}`;
    let literal = this.cachedValueLiteral(key);
    let completeAvailable = literal !== undefined;
    if (literal === undefined) {
      const record = await this.recordText(physicalLine, cancelled);
      literal = jsonLiteralAtPointer(record.raw, pointer);
      completeAvailable = this.rememberValueLiteral(key, literal);
    }
    if (cancelled()) throw new PreviewError('CANCELLED', 'Value request cancelled.');

    let safeOffset = Number.isSafeInteger(offset) ? Math.max(0, Math.min(literal.length, offset)) : 0;
    // Never begin or end a response between a UTF-16 surrogate pair. The
    // client advances with nextOffset, so a non-BMP character remains intact.
    if (safeOffset > 0 && safeOffset < literal.length) {
      const current = literal.charCodeAt(safeOffset);
      const previous = literal.charCodeAt(safeOffset - 1);
      if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) safeOffset--;
    }
    if (!completeAvailable && safeOffset > 0) {
      throw new PreviewError('VALUE_TOO_LARGE', `This value exceeds the safe ${VALUE_CACHE_MAX_CHARS.toLocaleString()}-character in-view limit. Open the source to inspect it without pinning another full copy in memory.`);
    }
    const limit = Math.min(MAX_VALUE_CHUNK_CHARS, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : MAX_VALUE_CHUNK_CHARS));
    let nextOffset = Math.min(literal.length, safeOffset + limit);
    if (nextOffset < literal.length) {
      const previous = literal.charCodeAt(nextOffset - 1);
      const current = literal.charCodeAt(nextOffset);
      if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) nextOffset++;
    }
    const result: JsonlValueChunkResult = {
      physicalLine,
      pointer,
      offset: safeOffset,
      nextOffset,
      totalChars: literal.length,
      chunk: literal.slice(safeOffset, nextOffset),
      done: nextOffset >= literal.length,
      completeAvailable,
    };
    await this.assertSourceUnchanged();
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queryGeneration++;
    if (this.sourcePollTimer) {
      clearInterval(this.sourcePollTimer);
      this.sourcePollTimer = undefined;
    }
    await Promise.all([...this.results.values()].map((result) => result.close()));
    this.results.clear();
    this.treeCache.clear();
    this.treeCacheBytes = 0;
    this.valueCache.clear();
    this.valueCacheChars = 0;
    if (this.index) await this.index.close();
    if (this.source.type === 'file') await this.source.handle.close();
  }
}
