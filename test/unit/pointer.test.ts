import { describe, expect, it } from 'vitest';
import {
  decodePointerSegment,
  encodePointerSegment,
  jqPathFromPath,
  joinPointer,
  parentPointer,
  pathFromPointer,
  pointerFromPath,
  valueAtPointer,
} from '../../src/shared/pointer.js';

describe('JSON Pointer utilities', () => {
  it('round-trips escaped property names', () => {
    const path = ['a/b', 'tilde~key', '0'];
    const pointer = pointerFromPath(path);
    expect(pointer).toBe('/a~1b/tilde~0key/0');
    expect(pathFromPointer(pointer)).toEqual(path);
    expect(encodePointerSegment('~/')).toBe('~0~1');
    expect(decodePointerSegment('~0~1')).toBe('~/');
  });

  it('navigates arrays without confusing numeric object keys', () => {
    const value = { '0': { rows: [{ '1': 'hit' }] } };
    expect(valueAtPointer(value, '/0/rows/0/1')).toBe('hit');
    expect(valueAtPointer(value, '/0/rows/2')).toBeUndefined();
    expect(joinPointer('/0', 'a/b')).toBe('/0/a~1b');
    expect(parentPointer('/0/a~1b')).toBe('/0');
  });

  it('rejects malformed pointers', () => {
    expect(() => pathFromPointer('not-a-pointer')).toThrow(/Invalid JSON Pointer/);
    expect(() => decodePointerSegment('bad~2escape')).toThrow(/Invalid JSON Pointer segment/);
  });

  it('renders typed paths as expressions that can be pasted into jq', () => {
    expect(jqPathFromPath([])).toBe('.');
    expect(jqPathFromPath(['users', 0, 'name'])).toBe('.users[0].name');
    expect(jqPathFromPath(['0', 'a-b', 'space key'])).toBe('.["0"]["a-b"]["space key"]');
    expect(jqPathFromPath(['quote"slash\\line\n'])).toBe('.["quote\\"slash\\\\line\\n"]');
  });
});
