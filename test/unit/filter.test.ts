import { describe, expect, it } from 'vitest';
import { compactSortValue, compareDecimals, compareSortValues, flattenForTable, matchesStructuredFilter } from '../../src/worker/filter.js';

describe('JSONL filters', () => {
  it('compares arbitrary decimal lexemes without rounding', () => {
    expect(compareDecimals('900719925474099312345', '900719925474099312344')).toBe(1);
    expect(compareDecimals('-1.20e3', '-1200')).toBe(0);
    expect(compareDecimals('0.00001', '1e-5')).toBe(0);
    expect(compareDecimals('-2', '-10')).toBe(1);
  });

  it('supports comparison, contains, exists and null predicates', () => {
    const value = { id: 90071992547409930000, name: 'Hello 世界', optional: null };
    const exact = new Map([['/id', '90071992547409930000']]);
    expect(matchesStructuredFilter(value, { op: 'compare', pointer: '/id', comparator: 'eq', value: { kind: 'number', value: '90071992547409930000' } }, exact)).toBe(true);
    expect(matchesStructuredFilter(value, { op: 'contains', pointer: '/name', value: '世界', caseSensitive: false })).toBe(true);
    expect(matchesStructuredFilter(value, { op: 'exists', pointer: '/optional' })).toBe(true);
    expect(matchesStructuredFilter(value, { op: 'isNull', pointer: '/optional' })).toBe(true);
    expect(matchesStructuredFilter(value, { op: 'exists', pointer: '/missing' })).toBe(false);
  });

  it('flattens nested objects into JSON Pointer columns', () => {
    expect(flattenForTable({ user: { name: 'Ada', tags: ['a', 'b'] }, ok: true })).toEqual({
      '/user/name': 'Ada',
      '/user/tags': '["a","b"]',
      '/ok': true,
    });
  });

  it('sorts values deterministically by type and value', () => {
    expect(compareSortValues(2, 10)).toBeLessThan(0);
    expect(compareSortValues('2', 10)).toBeGreaterThan(0);
    expect(compareSortValues(1, 1, '9007199254740993', '9007199254740992')).toBeGreaterThan(0);
  });

  it('compacts object sort keys instead of retaining parsed record graphs', () => {
    const value = { nested: { score: 2 } };
    const compact = compactSortValue(value) as { text: string };
    expect(compact).not.toBe(value);
    expect(compact.text).toBe('{"nested":{"score":2}}');
    expect(compareSortValues(compact, compact)).toBe(0);
  });
});
