import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceSignature } from '../shared/types.js';
import { PreviewError } from './errors.js';

export const LINE_INDEX_BLOCK_SIZE = 4096;
const INDEX_VERSION = 1;

export interface LineRecord {
  physicalLine: number;
  start: number;
  contentLength: number;
  eolLength: 0 | 1 | 2;
}

interface BlockMetadata {
  firstLine: number;
  count: number;
  sourceStart: number;
  indexOffset: number;
  payloadBytes: number;
}

interface IndexMetadata {
  version: number;
  sourceBytes: number;
  lineCount: number;
  builtAt: number;
  signature: SourceSignature;
  blocks: BlockMetadata[];
}

interface DecodedBlock {
  starts: Float64Array;
  lengths: Float64Array;
  eols: Uint8Array;
}

function sameSignature(left: SourceSignature, right: SourceSignature): boolean {
  const edgeMatches = left.edgeHash === undefined && right.edgeHash === undefined
    ? true
    : left.edgeHash !== undefined && right.edgeHash !== undefined && left.edgeHash === right.edgeHash;
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && (left.dev === undefined || right.dev === undefined || left.dev === right.dev)
    && (left.ino === undefined || right.ino === undefined || left.ino === right.ino)
    && edgeMatches;
}

function encodeVarint(value: number, output: number[]): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new PreviewError('INDEX_RANGE', `Cannot encode index value: ${value}`);
  let remaining = value;
  while (remaining >= 128) {
    output.push((remaining % 128) + 128);
    remaining = Math.floor(remaining / 128);
  }
  output.push(remaining);
}

function decodeVarint(buffer: Uint8Array, cursor: { value: number }): number {
  let result = 0;
  let multiplier = 1;
  for (let count = 0; count < 9; count++) {
    const byte = buffer[cursor.value++];
    if (byte === undefined) throw new PreviewError('CORRUPT_INDEX', 'Unexpected end of line-index block.');
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return result;
    multiplier *= 128;
  }
  throw new PreviewError('CORRUPT_INDEX', 'Line-index varint is too long.');
}

export async function computeFileSignature(path: string, expected?: SourceSignature): Promise<SourceSignature> {
  const source = await stat(path);
  if (expected && (source.size !== expected.size
    || source.mtimeMs !== expected.mtimeMs
    || (expected.dev !== undefined && source.dev !== expected.dev)
    || (expected.ino !== undefined && source.ino !== expected.ino))) {
    throw new PreviewError('SOURCE_CHANGED', 'The source file changed before it could be opened.');
  }
  const handle = await open(path, 'r');
  try {
    const edgeLength = Math.min(64 * 1024, source.size);
    const first = Buffer.alloc(edgeLength);
    const last = Buffer.alloc(edgeLength);
    if (edgeLength > 0) {
      await handle.read(first, 0, edgeLength, 0);
      await handle.read(last, 0, edgeLength, Math.max(0, source.size - edgeLength));
    }
    const edgeHash = createHash('sha256').update(first).update(last).digest('hex');
    if (expected?.edgeHash !== undefined && expected.edgeHash !== edgeHash) {
      throw new PreviewError('SOURCE_CHANGED', 'The source file changed before it could be opened.');
    }
    return { size: source.size, mtimeMs: source.mtimeMs, dev: source.dev, ino: source.ino, edgeHash };
  } finally {
    await handle.close();
  }
}

export class DiskLineIndex {
  private readonly decoded = new Map<number, DecodedBlock>();
  private closed = false;

  private constructor(
    readonly indexPath: string,
    readonly metadataPath: string,
    private readonly handle: FileHandle,
    private readonly metadata: IndexMetadata,
    private readonly ephemeral: boolean,
  ) {}

  static async tryLoad(indexPath: string, metadataPath: string, signature: SourceSignature): Promise<DiskLineIndex | undefined> {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as IndexMetadata;
      if (metadata.version !== INDEX_VERSION || !sameSignature(metadata.signature, signature)) return undefined;
      if (metadata.sourceBytes !== signature.size
        || !Number.isSafeInteger(metadata.lineCount)
        || metadata.lineCount < 0
        || !Array.isArray(metadata.blocks)) return undefined;
      let expectedFirstLine = 0;
      let expectedIndexOffset = 0;
      for (const block of metadata.blocks) {
        if (!Number.isSafeInteger(block.firstLine) || block.firstLine !== expectedFirstLine
          || !Number.isSafeInteger(block.count) || block.count <= 0 || block.count > LINE_INDEX_BLOCK_SIZE
          || !Number.isSafeInteger(block.sourceStart) || block.sourceStart < 0
          || !Number.isSafeInteger(block.indexOffset) || block.indexOffset !== expectedIndexOffset
          || !Number.isSafeInteger(block.payloadBytes) || block.payloadBytes <= 0) return undefined;
        expectedFirstLine += block.count;
        expectedIndexOffset += block.payloadBytes;
      }
      if (expectedFirstLine !== metadata.lineCount) return undefined;
      const indexDetails = await stat(indexPath);
      if (indexDetails.size !== expectedIndexOffset) return undefined;
      const handle = await open(indexPath, 'r');
      const now = new Date();
      void Promise.all([utimes(indexPath, now, now), utimes(metadataPath, now, now)]).catch(() => undefined);
      return new DiskLineIndex(indexPath, metadataPath, handle, metadata, false);
    } catch {
      return undefined;
    }
  }

  static async buildFile(
    sourcePath: string,
    indexPath: string,
    metadataPath: string,
    signature: SourceSignature,
    progress: (scannedBytes: number, records: number) => void,
    cancelled: () => boolean,
  ): Promise<DiskLineIndex> {
    return DiskLineIndex.build(
      createReadStream(sourcePath, { highWaterMark: 4 * 1024 * 1024 }),
      indexPath,
      metadataPath,
      signature,
      false,
      progress,
      cancelled,
    );
  }

  static async buildBuffer(
    bytes: Uint8Array,
    indexPath: string,
    metadataPath: string,
    progress: (scannedBytes: number, records: number) => void,
    cancelled: () => boolean,
  ): Promise<DiskLineIndex> {
    const signature: SourceSignature = {
      size: bytes.byteLength,
      mtimeMs: 0,
      edgeHash: createHash('sha256').update(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).update(bytes.subarray(Math.max(0, bytes.length - 64 * 1024))).digest('hex'),
    };
    async function* chunks(): AsyncIterable<Uint8Array> { yield bytes; }
    return DiskLineIndex.build(chunks(), indexPath, metadataPath, signature, true, progress, cancelled);
  }

  private static async build(
    chunks: AsyncIterable<Uint8Array>,
    indexPath: string,
    metadataPath: string,
    signature: SourceSignature,
    ephemeral: boolean,
    progress: (scannedBytes: number, records: number) => void,
    cancelled: () => boolean,
  ): Promise<DiskLineIndex> {
    await mkdir(dirname(indexPath), { recursive: true });
    const suffix = `.tmp-${randomUUID()}`;
    const temporaryIndex = `${indexPath}${suffix}`;
    const temporaryMetadata = `${metadataPath}${suffix}`;
    const output = await open(temporaryIndex, 'wx');
    const blocks: BlockMetadata[] = [];
    let blockValues: number[] = [];
    let blockSourceStart = 0;
    let blockFirstLine = 0;
    let indexOffset = 0;
    let lineCount = 0;
    let lineStart = 0;
    let scanned = 0;
    let previousByte: number | undefined;
    let lastProgress = performance.now();

    const flush = async (): Promise<void> => {
      if (blockValues.length === 0) return;
      const payload = Buffer.from(blockValues);
      await output.write(payload, 0, payload.length, indexOffset);
      blocks.push({ firstLine: blockFirstLine, count: lineCount - blockFirstLine, sourceStart: blockSourceStart, indexOffset, payloadBytes: payload.length });
      indexOffset += payload.length;
      blockValues = [];
      blockFirstLine = lineCount;
    };

    const append = (start: number, contentLength: number, eolLength: 0 | 1 | 2): Promise<void> | undefined => {
      if (blockValues.length === 0) blockSourceStart = start;
      encodeVarint(contentLength * 4 + eolLength, blockValues);
      lineCount++;
      if (lineCount - blockFirstLine >= LINE_INDEX_BLOCK_SIZE) return flush();
      return undefined;
    };

    try {
      for await (const input of chunks) {
        if (cancelled()) throw new PreviewError('CANCELLED', 'Indexing cancelled.');
        const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        let cursor = 0;
        while (cursor < chunk.length) {
          const newline = chunk.indexOf(0x0a, cursor);
          if (newline < 0) break;
          const absoluteNewline = scanned + newline;
          const before = newline > 0 ? chunk[newline - 1] : previousByte;
          const eolLength: 1 | 2 = before === 0x0d ? 2 : 1;
          const contentLength = absoluteNewline - lineStart - (eolLength === 2 ? 1 : 0);
          const pending = append(lineStart, Math.max(0, contentLength), eolLength);
          if (pending) await pending;
          lineStart = absoluteNewline + 1;
          cursor = newline + 1;
        }
        previousByte = chunk.length > 0 ? chunk[chunk.length - 1] : previousByte;
        scanned += chunk.length;
        const now = performance.now();
        if (now - lastProgress >= 100) {
          progress(scanned, lineCount);
          lastProgress = now;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      if (lineStart < scanned) {
        const pending = append(lineStart, scanned - lineStart, 0);
        if (pending) await pending;
      }
      await flush();
      await output.sync();
      await output.close();
      const metadata: IndexMetadata = { version: INDEX_VERSION, sourceBytes: scanned, lineCount, builtAt: Date.now(), signature, blocks };
      await writeFile(temporaryMetadata, JSON.stringify(metadata));
      if (!ephemeral) {
        await Promise.all([unlink(indexPath).catch(() => undefined), unlink(metadataPath).catch(() => undefined)]);
      }
      await rename(temporaryIndex, indexPath);
      await rename(temporaryMetadata, metadataPath);
      progress(scanned, lineCount);
      return new DiskLineIndex(indexPath, metadataPath, await open(indexPath, 'r'), metadata, ephemeral);
    } catch (error) {
      await output.close().catch(() => undefined);
      await Promise.all([unlink(temporaryIndex).catch(() => undefined), unlink(temporaryMetadata).catch(() => undefined)]);
      throw error;
    }
  }

  get lineCount(): number { return this.metadata.lineCount; }
  get sourceBytes(): number { return this.metadata.sourceBytes; }
  get signature(): SourceSignature { return this.metadata.signature; }

  private blockIndexForLine(lineIndex: number): number {
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= this.lineCount) {
      throw new PreviewError('LINE_NOT_FOUND', `Line ${lineIndex + 1} does not exist.`);
    }
    return Math.floor(lineIndex / LINE_INDEX_BLOCK_SIZE);
  }

  private async decodeBlock(blockIndex: number): Promise<DecodedBlock> {
    const existing = this.decoded.get(blockIndex);
    if (existing) {
      this.decoded.delete(blockIndex);
      this.decoded.set(blockIndex, existing);
      return existing;
    }
    const block = this.metadata.blocks[blockIndex];
    if (!block) throw new PreviewError('CORRUPT_INDEX', `Missing line-index block ${blockIndex}.`);
    const payload = Buffer.alloc(block.payloadBytes);
    const read = await this.handle.read(payload, 0, payload.length, block.indexOffset);
    if (read.bytesRead !== payload.length) throw new PreviewError('CORRUPT_INDEX', `Incomplete line-index block ${blockIndex}.`);
    const starts = new Float64Array(block.count);
    const lengths = new Float64Array(block.count);
    const eols = new Uint8Array(block.count);
    const cursor = { value: 0 };
    let sourceStart = block.sourceStart;
    for (let index = 0; index < block.count; index++) {
      const encoded = decodeVarint(payload, cursor);
      const eol = encoded % 4;
      const contentLength = Math.floor(encoded / 4);
      starts[index] = sourceStart;
      lengths[index] = contentLength;
      eols[index] = eol;
      sourceStart += contentLength + eol;
    }
    const decoded = { starts, lengths, eols };
    this.decoded.set(blockIndex, decoded);
    while (this.decoded.size > 32) this.decoded.delete(this.decoded.keys().next().value!);
    return decoded;
  }

  async get(lineIndex: number): Promise<LineRecord> {
    const blockIndex = this.blockIndexForLine(lineIndex);
    const block = this.metadata.blocks[blockIndex]!;
    const decoded = await this.decodeBlock(blockIndex);
    const local = lineIndex - block.firstLine;
    return {
      physicalLine: lineIndex + 1,
      start: decoded.starts[local]!,
      contentLength: decoded.lengths[local]!,
      eolLength: decoded.eols[local]! as 0 | 1 | 2,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
    this.decoded.clear();
    if (this.ephemeral) await Promise.all([unlink(this.indexPath).catch(() => undefined), unlink(this.metadataPath).catch(() => undefined)]);
  }
}
