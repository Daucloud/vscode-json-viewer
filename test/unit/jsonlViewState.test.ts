import { describe, expect, it } from 'vitest';
import type { JsonlRow } from '../../src/shared/types.js';
import { mergeRowFields, replaceRowByPhysicalLine } from '../../src/webview/jsonlState.js';

function row(physicalLine: number, cells: JsonlRow['cells']): JsonlRow {
  return { resultIndex: physicalLine, physicalLine, status: 'valid', cells, raw: JSON.stringify(cells) };
}

describe('JSONL local edit state', () => {
  it('replaces only the matching physical row and preserves its result position', () => {
    const first = row(4, { id: 1, name: 'Ada' });
    const second = row(9, { id: 2, name: 'Grace' });
    const rows = new Map([[17, first], [18, second]]);
    const updated = row(9, { id: 2, name: 'Hopper' });

    const next = replaceRowByPhysicalLine(rows, updated);

    expect(next.get(17)).toBe(first);
    expect(next.get(18)?.cells.name).toBe('Hopper');
    expect(next.get(18)?.resultIndex).toBe(second.resultIndex);
  });

  it('adds newly created properties to the table schema without duplicates', () => {
    expect(mergeRowFields(['/id'], row(1, { '/id': 1, '/active': true }))).toEqual(['/id', '/active']);
  });
});
