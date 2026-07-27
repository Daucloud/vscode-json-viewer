import { open, unlink, type FileHandle } from 'node:fs/promises';

const RECORD_BYTES = 16;
const BATCH_RECORDS = 4096;

export interface ResultRecord {
  physicalLine: number;
  sourceStart: number;
}

export class ResultIndexWriter {
  private readonly buffer = Buffer.alloc(RECORD_BYTES * BATCH_RECORDS);
  private buffered = 0;
  private count = 0;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(path: string): Promise<ResultIndexWriter> {
    return new ResultIndexWriter(path, await open(path, 'wx'));
  }

  append(record: ResultRecord): Promise<void> | undefined {
    const offset = this.buffered * RECORD_BYTES;
    this.buffer.writeDoubleLE(record.physicalLine, offset);
    this.buffer.writeDoubleLE(record.sourceStart, offset + 8);
    this.buffered++;
    this.count++;
    if (this.buffered === BATCH_RECORDS) return this.flush();
    return undefined;
  }

  private async flush(): Promise<void> {
    if (this.buffered === 0) return;
    const bytes = this.buffered * RECORD_BYTES;
    await this.handle.write(this.buffer, 0, bytes, null);
    this.buffered = 0;
  }

  async finish(): Promise<ResultIndex> {
    await this.flush();
    await this.handle.sync();
    await this.handle.close();
    return ResultIndex.open(this.path, this.count);
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await unlink(this.path).catch(() => undefined);
  }
}

export class ResultIndex {
  private closed = false;

  private constructor(
    readonly path: string,
    readonly count: number,
    private readonly handle: FileHandle,
  ) {}

  static async open(path: string, count: number): Promise<ResultIndex> {
    return new ResultIndex(path, count, await open(path, 'r'));
  }

  async page(offset: number, limit: number): Promise<ResultRecord[]> {
    const start = Math.max(0, Math.min(this.count, Math.floor(offset)));
    const count = Math.max(0, Math.min(Math.floor(limit), this.count - start));
    const buffer = Buffer.alloc(count * RECORD_BYTES);
    const result = await this.handle.read(buffer, 0, buffer.length, start * RECORD_BYTES);
    const records: ResultRecord[] = [];
    for (let position = 0; position + RECORD_BYTES <= result.bytesRead; position += RECORD_BYTES) {
      records.push({ physicalLine: buffer.readDoubleLE(position), sourceStart: buffer.readDoubleLE(position + 8) });
    }
    return records;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
    await unlink(this.path).catch(() => undefined);
  }
}
