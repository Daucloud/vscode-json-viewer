import { appendFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFileSignature, DiskLineIndex } from '../../src/worker/lineIndex.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fast-json-index-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('DiskLineIndex', () => {
  it('indexes BOM, UTF-8, LF, CRLF, empty lines, and a final line without EOL', async () => {
    const directory = await temporaryDirectory();
    const source = Buffer.from('\ufeff{"文本":1}\r\n\n{"last":true}', 'utf8');
    const index = await DiskLineIndex.buildBuffer(source, join(directory, 'lines.idx'), join(directory, 'lines.json'), () => undefined, () => false);
    expect(index.lineCount).toBe(3);
    const first = await index.get(0);
    const second = await index.get(1);
    const third = await index.get(2);
    expect(first).toMatchObject({ physicalLine: 1, start: 0, contentLength: Buffer.byteLength('\ufeff{"文本":1}'), eolLength: 2 });
    expect(second).toMatchObject({ physicalLine: 2, contentLength: 0, eolLength: 1 });
    expect(third).toMatchObject({ physicalLine: 3, contentLength: Buffer.byteLength('{"last":true}'), eolLength: 0 });
    await index.close();
  });

  it('handles CRLF split exactly across the 4 MB stream boundary', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, 'source.jsonl');
    const prefix = Buffer.alloc(4 * 1024 * 1024 - 1, 0x61);
    await writeFile(sourcePath, Buffer.concat([prefix, Buffer.from('\r\n{}\n')]));
    const signature = await computeFileSignature(sourcePath);
    const index = await DiskLineIndex.buildFile(sourcePath, join(directory, 'lines.idx'), join(directory, 'lines.json'), signature, () => undefined, () => false);
    expect(await index.get(0)).toMatchObject({ contentLength: prefix.length, eolLength: 2 });
    expect(await index.get(1)).toMatchObject({ contentLength: 2, eolLength: 1 });
    await index.close();
  });

  it('invalidates a cached index when source edge content changes', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, 'source.jsonl');
    const indexPath = join(directory, 'lines.idx');
    const metadataPath = join(directory, 'lines.json');
    await writeFile(sourcePath, '{"a":1}\n');
    const firstSignature = await computeFileSignature(sourcePath);
    const built = await DiskLineIndex.buildFile(sourcePath, indexPath, metadataPath, firstSignature, () => undefined, () => false);
    await built.close();
    expect(await DiskLineIndex.tryLoad(indexPath, metadataPath, firstSignature)).toBeDefined();
    const loaded = await DiskLineIndex.tryLoad(indexPath, metadataPath, firstSignature);
    await loaded?.close();

    const handle = await open(sourcePath, 'r+');
    await handle.write(Buffer.from('2'), 0, 1, 5);
    await handle.close();
    const changedSignature = await computeFileSignature(sourcePath);
    expect(changedSignature.edgeHash).not.toBe(firstSignature.edgeHash);
    expect(await DiskLineIndex.tryLoad(indexPath, metadataPath, changedSignature)).toBeUndefined();
  });

  it('rejects a cache file whose encoded payload size is corrupt', async () => {
    const directory = await temporaryDirectory();
    const sourcePath = join(directory, 'source.jsonl');
    const indexPath = join(directory, 'lines.idx');
    const metadataPath = join(directory, 'lines.json');
    await writeFile(sourcePath, '{"a":1}\n{"a":2}\n');
    const signature = await computeFileSignature(sourcePath);
    const built = await DiskLineIndex.buildFile(sourcePath, indexPath, metadataPath, signature, () => undefined, () => false);
    await built.close();
    await appendFile(indexPath, Buffer.from([0xff]));
    expect(await DiskLineIndex.tryLoad(indexPath, metadataPath, signature)).toBeUndefined();
  });
});
