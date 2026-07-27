import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSinglePhysicalJsonlRecord, isSingleRecordJsonlSource } from '../../src/worker/jsonlDetection.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('single-record JSONL detection', () => {
  it('accepts one record with an optional LF or CRLF terminator', () => {
    expect(isSinglePhysicalJsonlRecord('{"id":1}')).toBe(true);
    expect(isSinglePhysicalJsonlRecord('{"id":1}\n')).toBe(true);
    expect(isSinglePhysicalJsonlRecord('{"id":1}\r\n')).toBe(true);
    expect(isSinglePhysicalJsonlRecord('{"id":1}\n{"id":2}')).toBe(false);
    expect(isSinglePhysicalJsonlRecord('{"id":1}\n\n')).toBe(false);
    expect(isSinglePhysicalJsonlRecord('')).toBe(false);
  });

  it('stops file detection at the first real record boundary and observes the JSON size limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jsonl-detection-'));
    temporaryDirectories.push(directory);
    const singlePath = join(directory, 'single.jsonl');
    const multiplePath = join(directory, 'multiple.jsonl');
    await writeFile(singlePath, '{"id":1}\n');
    await writeFile(multiplePath, '{"id":1}\n{"id":2}\n');
    const singleStat = await stat(singlePath);
    const multipleStat = await stat(multiplePath);

    await expect(isSingleRecordJsonlSource({
      type: 'file', path: singlePath, signature: { size: singleStat.size, mtimeMs: singleStat.mtimeMs },
    }, 1024)).resolves.toBe(true);
    await expect(isSingleRecordJsonlSource({
      type: 'file', path: multiplePath, signature: { size: multipleStat.size, mtimeMs: multipleStat.mtimeMs },
    }, 1024)).resolves.toBe(false);
    await expect(isSingleRecordJsonlSource({
      type: 'file', path: singlePath, signature: { size: singleStat.size, mtimeMs: singleStat.mtimeMs },
    }, 2)).resolves.toBe(false);
  });
});
