import type { PreviewSettings } from './types.js';

export const DEFAULT_SETTINGS: PreviewSettings = {
  editableMaxBytes: 10 * 1024 * 1024,
  maxJsonBytes: 100 * 1024 * 1024,
  pageSize: 200,
  schemaSampleRows: 1000,
  maxLineBytes: 16 * 1024 * 1024,
  sortMaxRows: 1_000_000,
  indexCacheBytes: 1024 * 1024 * 1024,
};

export function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
