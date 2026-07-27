import { describe, expect, it } from 'vitest';
import { clampSplitPercent, normalizeSplitPercent, splitBounds } from '../../src/webview/ResizableSplit.js';

describe('resizable split sizing', () => {
  it('normalizes persisted values safely', () => {
    expect(normalizeSplitPercent(undefined, 72)).toBe(72);
    expect(normalizeSplitPercent(Number.NaN, 56)).toBe(56);
    expect(normalizeSplitPercent(-20, 50)).toBe(5);
    expect(normalizeSplitPercent(120, 50)).toBe(95);
  });

  it('derives percentage bounds from pane minimum widths', () => {
    const bounds = splitBounds(1_000, 420, 300);
    expect(bounds.minimum).toBe(42);
    expect(bounds.maximum).toBeCloseTo(69.1);
  });

  it('clamps drag positions without allowing either pane to collapse', () => {
    expect(clampSplitPercent(20, 1_000, 420, 300)).toBe(42);
    expect(clampSplitPercent(90, 1_000, 420, 300)).toBeCloseTo(69.1);
    expect(clampSplitPercent(55, 1_000, 420, 300)).toBe(55);
  });
});
