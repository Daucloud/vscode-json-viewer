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

  it('normalizes a wide persisted split when the editor is narrow', () => {
    const bounds = splitBounds(1_052, 420, 480);
    expect(bounds.minimum).toBeCloseTo(39.92, 2);
    expect(bounds.maximum).toBeCloseTo(53.52, 2);
    expect(clampSplitPercent(72, 1_052, 420, 480)).toBeCloseTo(bounds.maximum);
  });

  it('allows a practical drag range for the JSONL table and selected record', () => {
    const bounds = splitBounds(1_052, 240, 240);
    expect(bounds.minimum).toBeCloseTo(22.81, 2);
    expect(bounds.maximum).toBeCloseTo(76.33, 2);
    expect(clampSplitPercent(62, 1_052, 240, 240)).toBe(62);
  });
});
