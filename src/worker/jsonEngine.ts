import { visit } from 'jsonc-parser';
import { joinPointer, lastPointerSegment, parentPointer, pathFromPointer, pointerFromPath, valueAtPointer } from '../shared/pointer.js';
import type {
  JsonValueType,
  JsonSourceLocation,
  TreeChildrenResult,
  TreeNodeSummary,
  TreeSearchMatch,
  TreeSearchResult,
} from '../shared/types.js';
import { PreviewError } from './errors.js';

const MAX_PREVIEW = 180;
// Keep structured-clone payloads comfortably below the 1 MiB transport
// budget.  A node can carry an inline raw value for copy/edit operations, so
// counting only the number of children is not sufficient here.
export const MAX_TREE_MESSAGE_BYTES = 900 * 1024;
const UTF8_ENCODER = new TextEncoder();
const KEY_CACHE_MIN_KEYS = 256;
const KEY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const KEY_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
// Most documents contain only ordinary short numbers. A cheap lexical probe
// lets the common path skip jsonc-parser's full visitor entirely; false
// positives (digits inside a string) only cost an occasional scan, while a
// false negative would risk losing an exact numeric lexeme.
const MAYBE_UNSAFE_NUMBER = /[+-]?(?:(?:\d{16,})(?:\.\d*)?|(?:\d+\.\d{16,}))(?:[eE][+-]?\d+)?|[+-]?\d+[eE][+-]?\d+/;

function containsPotentialUnsafeNumber(text: string): boolean {
  if (!MAYBE_UNSAFE_NUMBER.test(text)) return false;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index);
    if (inString) {
      if (character === 0x5c) index++;
      else if (character === 0x22) inString = false;
      continue;
    }
    if (character === 0x22) {
      inString = true;
      continue;
    }
    if (character !== 0x2d && (character < 0x30 || character > 0x39)) continue;
    let cursor = index;
    if (text.charCodeAt(cursor) === 0x2d) cursor++;
    const integerStart = cursor;
    while (cursor < text.length && text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x39) cursor++;
    const integerDigits = cursor - integerStart;
    let fractionDigits = 0;
    if (text.charCodeAt(cursor) === 0x2e) {
      cursor++;
      const fractionStart = cursor;
      while (cursor < text.length && text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x39) cursor++;
      fractionDigits = cursor - fractionStart;
    }
    let exponent = false;
    if (text.charCodeAt(cursor) === 0x65 || text.charCodeAt(cursor) === 0x45) {
      exponent = true;
      cursor++;
      if (text.charCodeAt(cursor) === 0x2b || text.charCodeAt(cursor) === 0x2d) cursor++;
      while (cursor < text.length && text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x39) cursor++;
    }
    if (exponent || integerDigits >= 16 || fractionDigits >= 16) return true;
    index = Math.max(index, cursor - 1);
  }
  return false;
}

function truncate(value: string, length = MAX_PREVIEW): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function serializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : UTF8_ENCODER.encode(encoded).byteLength;
}

function withoutRaw(node: TreeNodeSummary): TreeNodeSummary {
  const { raw: _raw, ...compact } = node;
  return compact;
}

/**
 * Serialize only values that are provably small. Calling JSON.stringify first
 * and checking its length afterwards can duplicate a 100 MB container merely
 * because it has one top-level property. This iterative budget walk rejects
 * large strings/collections before allocating the encoded result.
 */
export function stringifyWithinLimit(value: unknown, maximumChars = 16_384): string | undefined {
  if (!Number.isFinite(maximumChars) || maximumChars < 0) return undefined;
  let remaining = Math.floor(maximumChars);
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) {
      remaining -= 4;
    } else if (typeof current === 'string') {
      if (current.length + 2 > remaining) return undefined;
      remaining -= JSON.stringify(current).length;
    } else if (typeof current === 'number') {
      remaining -= String(current).length;
    } else if (typeof current === 'boolean') {
      remaining -= current ? 4 : 5;
    } else if (Array.isArray(current)) {
      remaining -= 2 + Math.max(0, current.length - 1);
      if (remaining < 0) return undefined;
      for (let index = current.length - 1; index >= 0; index--) stack.push(current[index]);
    } else if (typeof current === 'object') {
      remaining -= 2;
      let properties = 0;
      for (const key in current as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (properties++ > 0) remaining--;
        if (key.length + 3 > remaining) return undefined;
        remaining -= JSON.stringify(key).length + 1;
        if (remaining < 0) return undefined;
        stack.push((current as Record<string, unknown>)[key]);
      }
    } else {
      return undefined;
    }
    if (remaining < 0) return undefined;
  }
  const encoded = JSON.stringify(value);
  return encoded !== undefined && encoded.length <= maximumChars ? encoded : undefined;
}

/**
 * Fit a tree page under the webview message budget while retaining as much
 * copyable raw data as possible.  If a page contains a few very large values,
 * those values lose only their optional `raw` field; the display preview and
 * JSON Pointer remain intact.  In the pathological case where even compact
 * rows do not fit, the page is shortened and the tree's “load next” marker
 * lets the UI continue paging.
 */
export function fitTreeChildrenResult(result: TreeChildrenResult): TreeChildrenResult {
  if (serializedBytes(result) <= MAX_TREE_MESSAGE_BYTES) return result;

  let parent = result.parent;
  let children = [...result.children];
  const replace = (nextParent: TreeNodeSummary | undefined, nextChildren: TreeNodeSummary[]): TreeChildrenResult => ({
    ...result,
    ...(nextParent === undefined ? {} : { parent: nextParent }),
    children: nextChildren,
  });

  // Strip the largest optional payloads first.  This normally preserves all
  // raw values except for the handful that caused the page to exceed 1 MiB.
  const candidates: Array<{ kind: 'parent' | 'child'; index: number; size: number }> = [];
  if (parent?.raw !== undefined) candidates.push({ kind: 'parent', index: -1, size: parent.raw.length });
  children.forEach((child, index) => {
    if (child.raw !== undefined) candidates.push({ kind: 'child', index, size: child.raw.length });
  });
  candidates.sort((left, right) => right.size - left.size);
  for (const candidate of candidates) {
    if (candidate.kind === 'parent' && parent) parent = withoutRaw(parent);
    if (candidate.kind === 'child') children[candidate.index] = withoutRaw(children[candidate.index]!);
    const compact = replace(parent, children);
    if (serializedBytes(compact) <= MAX_TREE_MESSAGE_BYTES) return compact;
  }

  // Raw fields are gone; keep a compact prefix of the page if unusually long
  // keys/pointers or previews still push the payload over the limit.
  parent = parent ? withoutRaw(parent) : undefined;
  children = children.map(withoutRaw);
  const fitted: TreeNodeSummary[] = [];
  for (const child of children) {
    const candidate = replace(parent, [...fitted, child]);
    if (serializedBytes(candidate) <= MAX_TREE_MESSAGE_BYTES) {
      fitted.push(child);
      continue;
    }
    const shortened: TreeNodeSummary = {
      ...child,
      key: truncate(child.key, 96),
      preview: truncate(child.preview, 96),
    };
    const shortenedCandidate = replace(parent, [...fitted, shortened]);
    if (serializedBytes(shortenedCandidate) > MAX_TREE_MESSAGE_BYTES) break;
    fitted.push(shortened);
  }
  return replace(parent, fitted);
}

export function jsonValueType(value: unknown): JsonValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  throw new PreviewError('UNSUPPORTED_VALUE', `Unsupported JSON value type: ${typeof value}`);
}

function isUnsafeIntegerLiteral(raw: string): boolean {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return false;
  try {
    const fraction = match[3] ?? '';
    let digits = `${match[2]}${fraction}`.replace(/^0+/, '') || '0';
    let exponent = Number(match[4] ?? 0) - fraction.length;
    if (exponent < 0) {
      const trailingZeros = digits.match(/0+$/)?.[0].length ?? 0;
      if (trailingZeros < -exponent) return false;
      digits = digits.slice(0, digits.length - (-exponent));
      exponent = 0;
    }
    if (digits !== '0' && (exponent > 1000 || digits.length + exponent > 32)) return true;
    const value = BigInt(`${match[1] === '-' ? '-' : ''}${digits}${'0'.repeat(exponent)}`);
    return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER);
  } catch {
    return false;
  }
}

export function collectUnsafeIntegers(text: string, targetPointer?: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!containsPotentialUnsafeNumber(text)) return result;
  visit(text, {
    onLiteralValue(value, offset, length, _line, _character, getPath) {
      if (typeof value !== 'number') return;
      let pointer: string | undefined;
      if (targetPointer !== undefined) {
        pointer = pointerFromPath(getPath());
        if (pointer !== targetPointer) return;
      }
      // Most JSON numbers are short, ordinary integers.  Avoid allocating a
      // substring and running the BigInt/regex path for those values.  An
      // unsafe integer is either long enough to contain 16 significant digits
      // or uses exponent notation (for example 9e18).
      if (length < 16) {
        let exponent = false;
        for (let index = offset; index < offset + length; index++) {
          const code = text.charCodeAt(index);
          if (code === 0x65 || code === 0x45) {
            exponent = true;
            break;
          }
        }
        if (!exponent) {
          // Keep duplicate-key handling aligned with JSON.parse, which keeps
          // the last occurrence even when that occurrence is safe.
          if (targetPointer !== undefined || result.size > 0) result.delete(pointer ??= pointerFromPath(getPath()));
          return;
        }
      }
      const raw = text.slice(offset, offset + length);
      if (isUnsafeIntegerLiteral(raw)) result.set(pointer ??= pointerFromPath(getPath()), raw);
      else if (targetPointer !== undefined || result.size > 0) result.delete(pointer ??= pointerFromPath(getPath()));
    },
  });
  return result;
}

function previewForValue(value: unknown, pointer: string, exactNumbers: ReadonlyMap<string, string>, includeContainerRaw: boolean, knownChildCount?: number): { preview: string; raw?: string } {
  const type = jsonValueType(value);
  if (type === 'object') {
    const count = knownChildCount ?? Object.keys(value as object).length;
    if (includeContainerRaw && count <= 32 && exactNumbers.size === 0) {
      const encoded = stringifyWithinLimit(value);
      if (encoded !== undefined) return { preview: `{${count} properties}`, raw: encoded };
    }
    return { preview: `{${count} properties}` };
  }
  if (type === 'array') {
    const count = (value as unknown[]).length;
    if (includeContainerRaw && count <= 32 && exactNumbers.size === 0) {
      const encoded = stringifyWithinLimit(value);
      if (encoded !== undefined) return { preview: `[${count} items]`, raw: encoded };
    }
    return { preview: `[${count} items]` };
  }
  if (type === 'string') {
    const raw = JSON.stringify(value);
    return { preview: truncate(raw), ...(raw.length <= 16_384 ? { raw } : {}) };
  }
  if (type === 'number') {
    const raw = exactNumbers.get(pointer) ?? String(value);
    return { preview: raw, raw };
  }
  if (type === 'boolean') {
    const raw = String(value);
    return { preview: raw, raw };
  }
  return { preview: 'null', raw: 'null' };
}

export class JsonEngine {
  private readonly keyCache = new Map<object, string[]>();
  private keyCacheBytes = 0;

  private constructor(
    private readonly root: unknown,
    private readonly exactNumbers: ReadonlyMap<string, string>,
    readonly parseMilliseconds: number,
    private readonly sourceText?: string,
    private readonly sourceOffset = 0,
  ) {}

  private keysFor(value: object): string[] {
    const existing = this.keyCache.get(value);
    if (existing) {
      this.keyCache.delete(value);
      this.keyCache.set(value, existing);
      return existing;
    }
    const keys = Object.keys(value);
    const estimatedBytes = keys.length * 16;
    if (keys.length >= KEY_CACHE_MIN_KEYS && estimatedBytes <= KEY_CACHE_MAX_ENTRY_BYTES) {
      this.keyCache.set(value, keys);
      this.keyCacheBytes += estimatedBytes;
      while (this.keyCacheBytes > KEY_CACHE_MAX_BYTES && this.keyCache.size > 1) {
        const oldestKey = this.keyCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = this.keyCache.get(oldestKey);
        this.keyCache.delete(oldestKey);
        this.keyCacheBytes -= (oldest?.length ?? 0) * 16;
      }
    }
    return keys;
  }

  static parse(input: string, retainSource = false): JsonEngine {
    const sourceOffset = input.charCodeAt(0) === 0xfeff ? 1 : 0;
    const text = sourceOffset === 1 ? input.slice(1) : input;
    const started = performance.now();
    let root: unknown;
    try {
      root = JSON.parse(text) as unknown;
    } catch (error) {
      throw new PreviewError('INVALID_JSON', error instanceof Error ? error.message : String(error));
    }
    const exactNumbers = collectUnsafeIntegers(text);
    return new JsonEngine(root, exactNumbers, performance.now() - started, retainSource ? text : undefined, sourceOffset);
  }

  location(pointer: string): JsonSourceLocation {
    if (this.sourceText === undefined) throw new PreviewError('LOCATION_UNAVAILABLE', 'Exact source location is available for editable files only.');
    pathFromPointer(pointer);
    if (pointer === '') return { offset: this.sourceOffset };
    const targetParent = parentPointer(pointer) ?? '';
    const found = Symbol('found');
    const containers: string[] = [];
    let offset: number | undefined;
    const check = (candidateOffset: number, path: readonly (string | number)[]): void => {
      if (pointerFromPath(path) !== pointer) return;
      // JSON.parse keeps the last value for duplicate object keys. Keep the
      // matching source location in lockstep so “Open source” reveals the
      // value the tree actually displays.
      offset = candidateOffset + this.sourceOffset;
    };
    const beginContainer = (candidateOffset: number, path: readonly (string | number)[]): void => {
      const containerPointer = pointerFromPath(path);
      check(candidateOffset, path);
      containers.push(containerPointer);
    };
    const endContainer = (): void => {
      const containerPointer = containers.pop();
      // Once the target's parent closes, no later duplicate key can refer to
      // this pointer, so stop without scanning the rest of a large document.
      if (containerPointer === targetParent && offset !== undefined) throw found;
    };
    try {
      visit(this.sourceText, {
        onObjectBegin: (candidateOffset, _length, _line, _character, getPath) => beginContainer(candidateOffset, getPath()),
        onObjectEnd: () => endContainer(),
        onArrayBegin: (candidateOffset, _length, _line, _character, getPath) => beginContainer(candidateOffset, getPath()),
        onArrayEnd: () => endContainer(),
        onLiteralValue: (_value, candidateOffset, _length, _line, _character, getPath) => check(candidateOffset, getPath()),
      });
    } catch (error) {
      if (error !== found) throw error;
    }
    if (offset === undefined) throw new PreviewError('POINTER_NOT_FOUND', `JSON Pointer does not exist: ${pointer}`);
    return { offset };
  }

  private summaryValue(value: unknown, pointer: string, key: string, includeContainerRaw = true): TreeNodeSummary {
    const type = jsonValueType(value);
    const childCount = type === 'array' ? (value as unknown[]).length : type === 'object' ? this.keysFor(value as object).length : 0;
    const preview = previewForValue(value, pointer, this.exactNumbers, includeContainerRaw, childCount);
    return {
      pointer,
      key,
      type,
      preview: preview.preview,
      ...(preview.raw !== undefined ? { raw: preview.raw } : {}),
      childCount,
      hasChildren: childCount > 0,
    };
  }

  summary(pointer = '', key = 'JSON', includeContainerRaw = true): TreeNodeSummary {
    const value = valueAtPointer(this.root, pointer);
    if (value === undefined && pointer !== '') throw new PreviewError('POINTER_NOT_FOUND', `JSON Pointer does not exist: ${pointer}`);
    return this.summaryValue(value, pointer, key, includeContainerRaw);
  }

  children(pointer: string, offset: number, requestedLimit: number): TreeChildrenResult {
    const value = valueAtPointer(this.root, pointer);
    if (value === undefined && pointer !== '') throw new PreviewError('POINTER_NOT_FOUND', `JSON Pointer does not exist: ${pointer}`);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 200));
    const safeOffset = Number.isSafeInteger(offset) ? Math.max(0, offset) : 0;
    const children: TreeNodeSummary[] = [];
    let total = 0;
    if (Array.isArray(value)) {
      total = value.length;
      for (let index = safeOffset; index < Math.min(total, safeOffset + limit); index++) {
        children.push(this.summaryValue(value[index], joinPointer(pointer, index), String(index)));
      }
    } else if (value !== null && typeof value === 'object') {
      const keys = this.keysFor(value);
      total = keys.length;
      for (const key of keys.slice(safeOffset, safeOffset + limit)) {
        children.push(this.summaryValue((value as Record<string, unknown>)[key], joinPointer(pointer, key), key));
      }
    }
    return fitTreeChildrenResult({
      parentPointer: pointer,
      parent: this.summaryValue(value, pointer, pointer === '' ? 'JSON' : pointer.slice(pointer.lastIndexOf('/') + 1)),
      offset: safeOffset,
      total,
      children,
    });
  }

  childPage(parent: string, childPointer: string, requestedLimit: number): TreeChildrenResult {
    if (parentPointer(childPointer) !== parent) throw new PreviewError('POINTER_NOT_FOUND', `The node is not a direct child of ${parent || '/'}.`);
    const value = valueAtPointer(this.root, parent);
    const segment = lastPointerSegment(childPointer);
    if (segment === undefined) throw new PreviewError('POINTER_NOT_FOUND', 'The root node has no parent page.');
    let index = -1;
    if (Array.isArray(value) && /^\d+$/.test(segment)) index = Number(segment);
    else if (value !== null && typeof value === 'object') index = this.keysFor(value).indexOf(segment);
    if (!Number.isSafeInteger(index) || index < 0) throw new PreviewError('POINTER_NOT_FOUND', `JSON Pointer does not exist: ${childPointer}`);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 200));
    return this.children(parent, Math.floor(index / limit) * limit, limit);
  }

  async search(query: string, limit: number, cancelled: () => boolean): Promise<TreeSearchResult> {
    // Locale-independent folding is deterministic across local and remote
    // extension hosts and avoids the heavier locale lookup in this hot loop.
    const normalized = query.trim().toLowerCase();
    if (!normalized) return { matches: [], truncated: false, visited: 0 };
    const maximum = Math.min(10_000, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1_000));
    const matches: TreeSearchMatch[] = [];
    let matchPayloadBytes = 64;
    const stack: Array<{ value: unknown; pointer: string; key: string }> = [{ value: this.root, pointer: '', key: 'JSON' }];
    let visited = 0;
    while (stack.length > 0) {
      if ((visited & 8191) === 0) {
        if (cancelled()) throw new PreviewError('CANCELLED', 'Search cancelled.');
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (cancelled()) throw new PreviewError('CANCELLED', 'Search cancelled.');
      }
      const current = stack.pop()!;
      visited++;
      const summary = this.summaryValue(current.value, current.pointer, current.key, false);
      if (`${current.key}\n${summary.preview}`.toLowerCase().includes(normalized)) {
        const match = { pointer: summary.pointer, key: summary.key, type: summary.type, preview: summary.preview };
        const matchBytes = serializedBytes(match) + 1;
        if (matchPayloadBytes + matchBytes > MAX_TREE_MESSAGE_BYTES) return { matches, truncated: true, visited };
        matches.push(match);
        matchPayloadBytes += matchBytes;
        if (matches.length >= maximum) return { matches, truncated: stack.length > 0, visited };
      }
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index--) {
          stack.push({ value: current.value[index], pointer: joinPointer(current.pointer, index), key: String(index) });
        }
      } else if (current.value !== null && typeof current.value === 'object') {
        const object = current.value as Record<string, unknown>;
        const keys = this.keysFor(object);
        for (let index = keys.length - 1; index >= 0; index--) {
          const key = keys[index]!;
          stack.push({ value: object[key], pointer: joinPointer(current.pointer, key), key });
        }
      }
    }
    return { matches, truncated: false, visited };
  }
}
