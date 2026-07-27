import { valueAtPointer } from '../shared/pointer.js';
import type { FilterLiteral, JsonlCell, StructuredFilter } from '../shared/types.js';

export const MISSING = Symbol('missing');

function valueOrMissing(value: unknown, pointer: string): unknown | typeof MISSING {
  const result = valueAtPointer(value, pointer);
  return result === undefined ? MISSING : result;
}

function decimalParts(input: string): { sign: number; digits: string; exponent: number } | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(input.trim());
  if (!match) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const integer = match[2]!;
  const fraction = match[3] ?? '';
  const all = `${integer}${fraction}`.replace(/^0+/, '') || '0';
  if (all === '0') return { sign: 1, digits: '0', exponent: 0 };
  const trailing = all.match(/0+$/)?.[0].length ?? 0;
  return { sign, digits: all.slice(0, all.length - trailing), exponent: Number(match[4] ?? 0) - fraction.length + trailing };
}

export function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return Number.NaN;
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  const magnitudeA = a.digits.length + a.exponent;
  const magnitudeB = b.digits.length + b.exponent;
  if (magnitudeA !== magnitudeB) return (magnitudeA < magnitudeB ? -1 : 1) * a.sign;
  const length = Math.max(a.digits.length, b.digits.length);
  const paddedA = a.digits.padEnd(length, '0');
  const paddedB = b.digits.padEnd(length, '0');
  if (paddedA === paddedB) return 0;
  return (paddedA < paddedB ? -1 : 1) * a.sign;
}

function compareValue(value: unknown, literal: FilterLiteral, exactNumber?: string): number | undefined {
  if (literal.kind === 'number') {
    if (typeof value !== 'number') return undefined;
    const compared = compareDecimals(exactNumber ?? String(value), literal.value);
    return Number.isNaN(compared) ? undefined : compared;
  }
  if (literal.kind === 'null') return value === null ? 0 : 1;
  if (literal.kind === 'boolean') return typeof value === 'boolean' ? Number(value) - Number(literal.value) : undefined;
  return typeof value === 'string' ? (value === literal.value ? 0 : value < literal.value ? -1 : 1) : undefined;
}

export function matchesStructuredFilter(
  value: unknown,
  filter: StructuredFilter | undefined,
  exactNumbers: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (!filter) return true;
  const selected = valueOrMissing(value, filter.pointer);
  if (filter.op === 'exists') return selected !== MISSING;
  if (filter.op === 'isNull') return selected === null;
  if (selected === MISSING) return false;
  if (filter.op === 'contains') {
    if (typeof selected !== 'string') return false;
    return filter.caseSensitive
      ? selected.includes(filter.value)
      : selected.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
  }
  const order = compareValue(selected, filter.value, exactNumbers.get(filter.pointer));
  if (order === undefined) return filter.comparator === 'ne';
  return {
    eq: order === 0,
    ne: order !== 0,
    gt: order > 0,
    gte: order >= 0,
    lt: order < 0,
    lte: order <= 0,
  }[filter.comparator];
}

function compactCell(value: unknown): JsonlCell {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}…`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return String(value);
  return encoded.length <= 4096 ? encoded : `${encoded.slice(0, 4096)}…`;
}

export function flattenForTable(
  value: unknown,
  exactNumbers: ReadonlyMap<string, string> = new Map(),
  maximumFields = 200,
): Record<string, JsonlCell> {
  const output: Record<string, JsonlCell> = {};
  const stack: Array<{ value: unknown; pointer: string; depth: number }> = [{ value, pointer: '', depth: 0 }];
  while (stack.length > 0 && Object.keys(output).length < maximumFields) {
    const current = stack.pop()!;
    if (current.value !== null && typeof current.value === 'object' && !Array.isArray(current.value) && current.depth < 8) {
      const entries = Object.entries(current.value as Record<string, unknown>);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, child] = entries[index]!;
        const pointer = `${current.pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        stack.push({ value: child, pointer, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value === 'number' && exactNumbers.has(current.pointer)) output[current.pointer || '/'] = compactCell(exactNumbers.get(current.pointer)!);
    else output[current.pointer || '/'] = compactCell(current.value);
  }
  return output;
}

function rank(value: unknown): number {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') return 1;
  if (typeof value === 'boolean') return 2;
  if (value !== null && typeof value === 'object') return 3;
  if (value === null) return 4;
  return 5;
}

export function compareSortValues(left: unknown, right: unknown, leftExact?: string, rightExact?: string): number {
  const rankDifference = rank(left) - rank(right);
  if (rankDifference !== 0) return rankDifference;
  if (typeof left === 'number' && typeof right === 'number') return compareDecimals(leftExact ?? String(left), rightExact ?? String(right));
  if (typeof left === 'string' && typeof right === 'string') return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (left === null && right === null) return 0;
  const a = JSON.stringify(left) ?? '';
  const b = JSON.stringify(right) ?? '';
  return a === b ? 0 : a < b ? -1 : 1;
}
