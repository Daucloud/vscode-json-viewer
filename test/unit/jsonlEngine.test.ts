import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import type { PreviewSettings, WorkerEvent } from '../../src/shared/types.js';
import { JsonlEngine } from '../../src/worker/jsonlEngine.js';

const temporaryDirectories: string[] = [];

async function openText(text: string, settings: Partial<PreviewSettings> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fast-jsonl-'));
  temporaryDirectories.push(directory);
  const events: WorkerEvent[] = [];
  return JsonlEngine.open('test-session', { type: 'text', text }, { ...DEFAULT_SETTINGS, pageSize: 20, schemaSampleRows: 20, ...settings }, directory, 'test', (event) => events.push(event), () => false)
    .then((opened) => ({ ...opened, events }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JsonlEngine', () => {
  it('isolates BOM, CRLF, empty, invalid, UTF-8, and final records', async () => {
    const opened = await openText('\ufeff{"id":1,"文本":"好"}\r\n\nnot-json\n{"id":2}');
    expect(opened.result.indexReady).toBe(true);
    expect(opened.result.recordCount).toBe(4);
    const page = await opened.engine.page('default', 0, 20);
    expect(page.rows.map((row) => row.status)).toEqual(['valid', 'empty', 'invalid', 'valid']);
    expect(page.rows[0]?.cells['/文本']).toBe('好');
    expect(page.rows[2]?.diagnostic?.code).toBe('INVALID_JSON');
    await opened.engine.close();
  });

  it('marks a long record independently and continues parsing following rows', async () => {
    const opened = await openText(`${JSON.stringify({ payload: 'x'.repeat(200) })}\n{"ok":true}\n`, { maxLineBytes: 64 });
    const page = await opened.engine.page('default', 0, 20);
    expect(page.rows[0]?.status).toBe('tooLarge');
    expect(page.rows[1]?.status).toBe('valid');
    await opened.engine.close();
  });

  it('streams full-text search across records that exceed the parse limit', async () => {
    const opened = await openText(`${JSON.stringify({ payload: `${'x'.repeat(5_000)}needle-at-end` })}\n{"ok":true}\n`, { maxLineBytes: 64 });
    const query = await opened.engine.query('long-search', { text: 'needle-at-end' }, 'request', () => false);
    expect(query.matchedRows).toBe(1);
    const page = await opened.engine.page('long-search', 0, 20);
    expect(page.rows[0]).toMatchObject({ physicalLine: 1, status: 'tooLarge' });
    await opened.engine.close();
  });

  it('keeps pathological table rows within the webview message budget', async () => {
    const value = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field-${index}`, '界'.repeat(4_096)]));
    const opened = await openText(`${JSON.stringify(value)}\n`);
    const page = await opened.engine.page('default', 0, 20);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(900 * 1024);
    expect(page.rows[0]?.rawTruncated).toBe(true);
    await opened.engine.close();
  });

  it('loads complete JSONL values above the inline limit in bounded chunks', async () => {
    const source = JSON.stringify({ payload: 'x'.repeat(40_000), tail: true });
    const opened = await openText(`${source}\n`);
    const tree = await opened.engine.treeChildren(1, '', 0, 20);
    expect(tree.parent?.raw).toBeUndefined();

    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const response = await opened.engine.valueChunk(1, '', offset, 5_000);
      expect(response.offset).toBe(offset);
      expect(response.chunk.length).toBeLessThanOrEqual(5_001);
      chunks.push(response.chunk);
      offset = response.nextOffset;
      if (response.done) break;
    }
    expect(chunks.join('')).toBe(source);
    await opened.engine.close();
  });

  it('preserves unsafe integer and escaped string literals in selected values', async () => {
    const source = '{"nested":{"id":900719925474099312345,"message":"line\\nnext"}}';
    const opened = await openText(source);
    const response = await opened.engine.valueChunk(1, '/nested', 0, 128 * 1024);
    expect(response).toMatchObject({ done: true, completeAvailable: true });
    expect(response.chunk).toBe('{"id":900719925474099312345,"message":"line\\nnext"}');
    await opened.engine.close();
  });

  it('keeps value chunks below the worker message budget and surrogate pairs intact', async () => {
    const source = JSON.stringify('😀'.repeat(100_000));
    const opened = await openText(source);
    const first = await opened.engine.valueChunk(1, '', 0, Number.MAX_SAFE_INTEGER);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(900 * 1024);
    const tiny = await opened.engine.valueChunk(1, '', 0, 2);
    expect(tiny.chunk).toBe('"😀');
    expect(tiny.nextOffset).toBe(3);
    await opened.engine.close();
  });

  it('marks invalid UTF-8 on one file-backed record without affecting the next row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jsonl-invalid-utf8-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'invalid.jsonl');
    await writeFile(sourcePath, Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}\n{"ok":true}\n')]));
    const details = await stat(sourcePath);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const opened = await JsonlEngine.open(
      'utf8-session',
      { type: 'file', path: sourcePath, signature: { size: details.size, mtimeMs: details.mtimeMs } },
      { ...DEFAULT_SETTINGS, pageSize: 20, schemaSampleRows: 20 },
      join(directory, 'cache'),
      'utf8',
      (event) => { if (event.event === 'indexReady') resolveReady(); },
      () => false,
    );
    expect(opened.result.initialRows.map((row) => row.status)).toEqual(['invalid', 'valid']);
    expect(opened.result.initialRows[0]?.diagnostic?.code).toBe('INVALID_UTF8');
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Index timeout')), 2000))]);
    await opened.engine.close();
  });

  it('rejects stale pages after a file-backed source changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jsonl-source-change-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'records.jsonl');
    await writeFile(sourcePath, '{"id":1}\n{"id":2}\n');
    const details = await stat(sourcePath);
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const opened = await JsonlEngine.open(
      'changed-session',
      { type: 'file', path: sourcePath, signature: { size: details.size, mtimeMs: details.mtimeMs } },
      { ...DEFAULT_SETTINGS, pageSize: 20, schemaSampleRows: 20 },
      join(directory, 'cache'),
      'changed',
      (event) => { if (event.event === 'indexReady') resolveReady(); },
      () => false,
    );
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Index timeout')), 2000))]);
    await writeFile(sourcePath, '{"id":1}\n{"id":2}\n{"id":3}\n');
    await expect(opened.engine.page('default', 0, 20)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await opened.engine.close();
  });

  it('detects file changes in the background without waiting for another page request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jsonl-source-monitor-'));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, 'records.jsonl');
    await writeFile(sourcePath, '{"id":1}\n{"id":2}\n');
    const details = await stat(sourcePath);
    const events: WorkerEvent[] = [];
    const opened = await JsonlEngine.open(
      'monitor-session',
      { type: 'file', path: sourcePath, signature: { size: details.size, mtimeMs: details.mtimeMs } },
      { ...DEFAULT_SETTINGS, pageSize: 20, schemaSampleRows: 20 },
      join(directory, 'cache'),
      'monitor',
      (event) => events.push(event),
      () => false,
    );
    const indexDeadline = Date.now() + 2_000;
    while (!events.some((event) => event.event === 'indexReady') && Date.now() < indexDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events.some((event) => event.event === 'indexReady')).toBe(true);
    events.length = 0;
    await writeFile(sourcePath, '{"id":9}\n{"id":2}\n');
    const deadline = Date.now() + 2_500;
    while (!events.some((event) => event.event === 'warning' && event.code === 'SOURCE_CHANGED') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'warning', code: 'SOURCE_CHANGED' })]));
    await opened.engine.close();
  });

  it('filters exact unsafe integers and stores matches in a disk result index', async () => {
    const opened = await openText([
      '{"id":900719925474099312345,"name":"first"}',
      '{"id":2,"name":"second"}',
      '{"id":900719925474099312345,"name":"third"}',
    ].join('\n'));
    const query = await opened.engine.query('unsafe', {
      filter: { op: 'compare', pointer: '/id', comparator: 'eq', value: { kind: 'number', value: '900719925474099312345' } },
    }, 'request', () => false);
    expect(query.matchedRows).toBe(2);
    const page = await opened.engine.page('unsafe', 0, 20);
    expect(page.rows.map((row) => row.physicalLine)).toEqual([1, 3]);
    expect(page.rows[0]?.cells['/id']).toBe('900719925474099312345');
    await opened.engine.close();
  });

  it('sorts unsafe integer fields by their exact decimal lexemes', async () => {
    const opened = await openText([
      '{"id":900719925474099312347}',
      '{"id":900719925474099312345}',
      '{"id":900719925474099312346}',
    ].join('\n'));
    await opened.engine.query('unsafe-sort', { sort: { pointer: '/id', direction: 'asc' } }, 'request', () => false);
    const page = await opened.engine.page('unsafe-sort', 0, 20);
    expect(page.rows.map((row) => row.cells['/id'])).toEqual([
      '900719925474099312345',
      '900719925474099312346',
      '900719925474099312347',
    ]);
    await opened.engine.close();
  });

  it('supports raw text search and field sorting', async () => {
    const opened = await openText('{"rank":3,"name":"keep"}\n{"rank":1,"name":"drop"}\n{"rank":2,"name":"keep"}\n');
    const searched = await opened.engine.query('search', { text: 'keep' }, 'search-request', () => false);
    expect(searched.matchedRows).toBe(2);
    const sorted = await opened.engine.query('sort', { sort: { pointer: '/rank', direction: 'asc' } }, 'sort-request', () => false);
    expect(sorted.matchedRows).toBe(3);
    const page = await opened.engine.page('sort', 0, 20);
    expect(page.rows.map((row) => row.cells['/rank'])).toEqual([1, 2, 3]);
    await opened.engine.close();
  });

  it('keeps active disk-backed query results discoverable for cache protection', async () => {
    const opened = await openText('{"id":1}\n{"id":2}\n');
    expect(opened.engine.cachePaths().size).toBe(0);
    await opened.engine.query('active-result', { text: 'id' }, 'request', () => false);
    const paths = [...opened.engine.cachePaths()];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/query-/);
    await opened.engine.close();
  });

  it('cancels an older scan when a newer query starts in the same session', async () => {
    const text = Array.from({ length: 50_000 }, (_, index) => `{"id":${index}}`).join('\n');
    const opened = await openText(text);
    const first = opened.engine.query('first', { text: 'id' }, 'first-request', () => false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const latest = await opened.engine.query('latest', {}, 'latest-request', () => false);
    expect(latest.matchedRows).toBe(50_000);
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await opened.engine.close();
  });

  it('enforces the configured global sort limit', async () => {
    const opened = await openText('{"rank":2}\n{"rank":1}', { sortMaxRows: 1 });
    await expect(opened.engine.query('sort', { sort: { pointer: '/rank', direction: 'asc' } }, 'request', () => false)).rejects.toMatchObject({ code: 'SORT_LIMIT' });
    const filtered = await opened.engine.query('filtered-sort', {
      filter: { op: 'compare', pointer: '/rank', comparator: 'eq', value: { kind: 'number', value: '1' } },
      sort: { pointer: '/rank', direction: 'asc' },
    }, 'filtered-request', () => false);
    expect(filtered.matchedRows).toBe(1);
    await opened.engine.close();
  });

  it('rejects malformed query pointers before scanning records', async () => {
    const opened = await openText('{"id":1}\n');
    await expect(opened.engine.query('invalid-pointer', {
      filter: { op: 'exists', pointer: 'not-a-pointer' },
    }, 'request', () => false)).rejects.toMatchObject({ code: 'INVALID_POINTER' });
    await opened.engine.close();
  });
});
