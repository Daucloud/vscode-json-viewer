import type { JsonlRow } from '../shared/types.js';

export function replaceRowByPhysicalLine(rows: ReadonlyMap<number, JsonlRow>, updated: JsonlRow): Map<number, JsonlRow> {
  const next = new Map(rows);
  for (const [position, current] of rows) {
    if (current.physicalLine !== updated.physicalLine) continue;
    next.set(position, { ...updated, resultIndex: current.resultIndex });
  }
  return next;
}

export function mergeRowFields(fields: readonly string[], row: JsonlRow): string[] {
  const next = [...fields];
  const known = new Set(fields);
  for (const field of Object.keys(row.cells)) {
    if (known.has(field) || next.length >= 200) continue;
    known.add(field);
    next.push(field);
  }
  return next;
}
