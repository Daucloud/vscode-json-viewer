import { open } from 'node:fs/promises';
import type { WorkerSource } from './protocol.js';

const DETECTION_CHUNK_BYTES = 64 * 1024;

/**
 * JSONL permits one optional trailing LF (or CRLF) after the final record.
 * Any earlier LF means that the source has more than one physical record and
 * must retain JSONL's row-level error isolation.
 */
export function isSinglePhysicalJsonlRecord(text: string): boolean {
  if (text.length === 0) return false;
  const firstLineFeed = text.indexOf('\n');
  return firstLineFeed < 0 || firstLineFeed === text.length - 1;
}

/**
 * Detect a single physical record without reading ordinary multi-record JSONL
 * files wholesale. File-backed sources stop at the first LF, while candidates
 * above the complete-JSON limit stay in streaming JSONL mode.
 */
export async function isSingleRecordJsonlSource(source: WorkerSource, maximumJsonBytes: number): Promise<boolean> {
  const maximum = Math.max(0, maximumJsonBytes);
  if (source.type === 'text') {
    return Buffer.byteLength(source.text, 'utf8') <= maximum && isSinglePhysicalJsonlRecord(source.text);
  }
  const size = source.signature.size;
  if (size <= 0 || size > maximum) return false;

  const handle = await open(source.path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(DETECTION_CHUNK_BYTES, size));
    let position = 0;
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) return false;
      const lineFeed = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (lineFeed >= 0) return position + lineFeed === size - 1;
      position += bytesRead;
    }
    return true;
  } finally {
    await handle.close();
  }
}
