export type JsonPath = Array<string | number>;

export function encodePointerSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodePointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/.test(segment)) {
    throw new Error(`Invalid JSON Pointer segment: ${segment}`);
  }
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function pointerFromPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? '' : `/${path.map(encodePointerSegment).join('/')}`;
}

export function pathFromPointer(pointer: string): JsonPath {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(decodePointerSegment);
}

export function joinPointer(pointer: string, segment: string | number): string {
  return `${pointer}/${encodePointerSegment(segment)}`;
}

export function parentPointer(pointer: string): string | undefined {
  if (pointer === '') return undefined;
  const slash = pointer.lastIndexOf('/');
  return slash <= 0 ? '' : pointer.slice(0, slash);
}

export function lastPointerSegment(pointer: string): string | undefined {
  if (pointer === '') return undefined;
  return decodePointerSegment(pointer.slice(pointer.lastIndexOf('/') + 1));
}

export function valueAtPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of pathFromPointer(pointer)) {
    if (Array.isArray(current) && /^\d+$/.test(String(segment))) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[String(segment)];
      continue;
    }
    return undefined;
  }
  return current;
}
