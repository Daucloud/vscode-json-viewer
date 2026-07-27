import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const args = new Set(process.argv.slice(2));
const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : undefined;
};
const sizeGb = valueAfter('--size-gb');
const sizeMb = valueAfter('--size-mb') ?? (sizeGb ? sizeGb * 1024 : 100);
const assertTargets = args.has('--assert');
const keep = args.has('--keep');
const targetBytes = Math.floor(sizeMb * 1024 * 1024);
const directory = await mkdtemp(join(tmpdir(), 'fast-json-viewer-benchmark-'));
const cacheDirectory = join(directory, 'cache');
const workerPath = resolve('dist/worker.cjs');
let cleaned = false;

async function cleanup() {
  if (cleaned || keep) return;
  cleaned = true;
  await rm(directory, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function generateJsonl(path) {
  const output = createWriteStream(path, { highWaterMark: 8 * 1024 * 1024 });
  let bytes = 0;
  let row = 0;
  let chunk = '';
  let chunkBytes = 0;
  while (bytes + chunkBytes < targetBytes) {
    const line = JSON.stringify({ id: row, group: row % 10 === 0 ? 'target' : 'other', message: `record-${row}-` + 'x'.repeat(96) }) + '\n';
    chunk += line;
    chunkBytes += Buffer.byteLength(line);
    row++;
    if (chunk.length >= 4 * 1024 * 1024) {
      bytes += chunkBytes;
      await writeChunk(output, chunk);
      chunk = '';
      chunkBytes = 0;
    }
  }
  if (chunk) await writeChunk(output, chunk);
  output.end();
  await once(output, 'close');
  return { rows: row, bytes: (await stat(path)).size };
}

async function generateJson(path) {
  const output = createWriteStream(path, { highWaterMark: 8 * 1024 * 1024 });
  await writeChunk(output, '[');
  let bytes = 1;
  let row = 0;
  let chunk = '';
  let chunkBytes = 0;
  while (bytes + chunkBytes < targetBytes - 256) {
    const item = `${row === 0 ? '' : ','}${JSON.stringify({ id: row, active: row % 2 === 0, message: `item-${row}-` + 'y'.repeat(112) })}`;
    chunk += item;
    chunkBytes += Buffer.byteLength(item);
    row++;
    if (chunk.length >= 4 * 1024 * 1024) {
      bytes += chunkBytes;
      await writeChunk(output, chunk);
      chunk = '';
      chunkBytes = 0;
    }
  }
  if (chunk) await writeChunk(output, chunk);
  await writeChunk(output, ']');
  output.end();
  await once(output, 'close');
  return { rows: row, bytes: (await stat(path)).size };
}

class RpcWorker {
  constructor() {
    this.worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 128 } });
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
    this.worker.on('message', (message) => {
      if (message.type === 'event') {
        this.events.push(message.data);
        for (const listener of this.listeners.splice(0)) listener(message.data);
        return;
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(Object.assign(new Error(message.error.message), message.error));
    });
    this.worker.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }
  request(body, requestId = crypto.randomUUID()) {
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...body, requestId });
    });
  }
  waitFor(predicate) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const listener = (event) => {
        if (predicate(event)) resolve(event);
        else this.listeners.push(listener);
      };
      this.listeners.push(listener);
    });
  }
  async close() { await this.worker.terminate(); }
}

const settings = {
  editableMaxBytes: 10 * 1024 * 1024,
  maxJsonBytes: 100 * 1024 * 1024,
  pageSize: 200,
  schemaSampleRows: 1000,
  maxLineBytes: 16 * 1024 * 1024,
  sortMaxRows: 1_000_000,
  indexCacheBytes: 1024 * 1024 * 1024,
};

function elapsed(started) { return Number(process.hrtime.bigint() - started) / 1e6; }
function mb(bytes) { return bytes / 1024 / 1024; }
const failures = [];

try {
  const jsonlPath = join(directory, 'benchmark.jsonl');
  process.stdout.write(`Generating ${sizeMb.toLocaleString()} MB JSONL fixture…\n`);
  const jsonl = await generateJsonl(jsonlPath);
  const jsonlWorker = new RpcWorker();
  const sourceStat = await stat(jsonlPath);
  const openStarted = process.hrtime.bigint();
  const opened = await jsonlWorker.request({
    type: 'session/open', sessionId: 'jsonl', kind: 'jsonl',
    source: { type: 'file', path: jsonlPath, signature: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs } },
    settings, cacheDirectory, cacheKey: 'benchmark-jsonl',
  });
  const firstPageMs = elapsed(openStarted);
  process.stdout.write(`JSONL first page: ${firstPageMs.toFixed(1)} ms (${opened.initialRows.length} rows)\n`);
  const indexEvent = opened.indexReady ? { indexMilliseconds: opened.indexMilliseconds ?? 0, recordCount: opened.recordCount } : await jsonlWorker.waitFor((event) => event.event === 'indexReady');
  process.stdout.write(`JSONL line index: ${indexEvent.indexMilliseconds.toFixed(1)} ms (${indexEvent.recordCount.toLocaleString()} records)\n`);

  const queryStarted = process.hrtime.bigint();
  const query = await jsonlWorker.request({
    type: 'jsonl/query', sessionId: 'jsonl', queryId: 'filter',
    spec: { filter: { op: 'compare', pointer: '/group', comparator: 'eq', value: { kind: 'string', value: 'target' } } },
  });
  const queryMs = elapsed(queryStarted);
  const throughput = mb(jsonl.bytes) / (queryMs / 1000);
  process.stdout.write(`JSONL field filter: ${queryMs.toFixed(1)} ms, ${throughput.toFixed(1)} MB/s, ${query.matchedRows.toLocaleString()} matches\n`);
  const memory = await jsonlWorker.request({ type: 'diagnostics/memory' });
  const stableWorkerMemory = memory.heapUsed + memory.external;
  process.stdout.write(`JSONL process RSS: ${mb(memory.rss).toFixed(1)} MB; worker heap + external: ${mb(stableWorkerMemory).toFixed(1)} MB\n`);

  const cancelRequestId = crypto.randomUUID();
  const cancellingQuery = jsonlWorker.request({ type: 'jsonl/query', sessionId: 'jsonl', queryId: 'cancelled', spec: { text: '__definitely_absent__' } }, cancelRequestId).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelStarted = process.hrtime.bigint();
  await jsonlWorker.request({ type: 'cancel', sessionId: 'jsonl', targetRequestId: cancelRequestId });
  const cancelledResult = await cancellingQuery;
  const cancelMs = elapsed(cancelStarted);
  process.stdout.write(`Query cancellation: ${cancelMs.toFixed(1)} ms (${cancelledResult.code ?? 'completed before cancellation'})\n`);

  if (assertTargets && sizeMb >= 95 && sizeMb <= 110) {
    if (firstPageMs > 1000) failures.push(`JSONL first page ${firstPageMs.toFixed(0)} ms exceeds 1000 ms`);
    if (queryMs > 2000) failures.push(`JSONL filter ${queryMs.toFixed(0)} ms exceeds 2000 ms`);
    if (throughput < 100) failures.push(`JSONL throughput ${throughput.toFixed(1)} MB/s is below 100 MB/s`);
    if (cancelMs > 200) failures.push(`Cancellation ${cancelMs.toFixed(0)} ms exceeds 200 ms`);
  }
  if (sizeGb && stableWorkerMemory > 256 * 1024 * 1024) failures.push(`JSONL worker heap + external ${mb(stableWorkerMemory).toFixed(1)} MB exceeds 256 MB`);
  await jsonlWorker.close();

  if (!sizeGb) {
    const jsonPath = join(directory, 'benchmark.json');
    process.stdout.write(`Generating ${sizeMb.toLocaleString()} MB JSON fixture…\n`);
    const json = await generateJson(jsonPath);
    const jsonWorker = new RpcWorker();
    const jsonStat = await stat(jsonPath);
    const jsonStarted = process.hrtime.bigint();
    const jsonOpened = await jsonWorker.request({
      type: 'session/open', sessionId: 'json', kind: 'json',
      source: { type: 'file', path: jsonPath, signature: { size: jsonStat.size, mtimeMs: jsonStat.mtimeMs } },
      settings, cacheDirectory, cacheKey: 'benchmark-json',
    });
    const jsonMs = elapsed(jsonStarted);
    const jsonMemory = await jsonWorker.request({ type: 'diagnostics/memory' });
    process.stdout.write(`JSON root: ${jsonMs.toFixed(1)} ms (${jsonOpened.root.childCount.toLocaleString()} children); RSS ${mb(jsonMemory.rss).toFixed(1)} MB\n`);
    if (assertTargets && sizeMb >= 95 && sizeMb <= 110) {
      if (jsonMs > 3000) failures.push(`JSON root ${jsonMs.toFixed(0)} ms exceeds 3000 ms`);
      if (jsonMemory.rss > 750 * 1024 * 1024) failures.push(`JSON RSS ${mb(jsonMemory.rss).toFixed(1)} MB exceeds 750 MB`);
    }
    await jsonWorker.close();
    void json;
  }

  if (failures.length > 0) {
    process.stderr.write(`\nPerformance gate failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
  }
} finally {
  if (keep) process.stdout.write(`Fixtures kept at ${directory}\n`);
  else await cleanup();
}
