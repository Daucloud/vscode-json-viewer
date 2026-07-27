/** @vitest-environment jsdom */

import { act, render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ResizableSplit } from '../../src/webview/ResizableSplit.js';

describe('ResizableSplit component', () => {
  it('keeps a preferred ratio across temporary container constraints', () => {
    let resize: ((entries: Array<{ contentRect: { width: number } }>) => void) | undefined;
    class TestResizeObserver {
      constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { resize = callback; }
      observe(): void {}
      disconnect(): void {}
    }
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    const onChange = vi.fn();
    try {
      const view = render(React.createElement(ResizableSplit, {
        className: 'test-split', defaultPercent: 72, initialPercent: 72,
        minStart: 420, minEnd: 480, label: 'Test split', onChange,
        children: [React.createElement('section', { key: 'start' }, 'Start'), React.createElement('aside', { key: 'end' }, 'End')],
      }));
      const separator = view.getByRole('separator');

      act(() => resize?.([{ contentRect: { width: 1_052 } }]));
      expect(separator.getAttribute('aria-valuenow')).toBe('54');
      expect(onChange).not.toHaveBeenCalled();

      act(() => resize?.([{ contentRect: { width: 2_000 } }]));
      expect(separator.getAttribute('aria-valuenow')).toBe('72');
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = previous;
    }
  });

  it('keeps both pane trees mounted while focusing the end pane', () => {
    const view = render(React.createElement(ResizableSplit, {
      className: 'test-split', defaultPercent: 62, minStart: 240, minEnd: 240,
      label: 'Test split', maximizedPane: 'end',
      children: [React.createElement('section', { key: 'start' }, 'Records'), React.createElement('aside', { key: 'end' }, 'Selected record')],
    }));
    expect(view.container.firstElementChild?.classList.contains('split-maximized-end')).toBe(true);
    expect(view.getByText('Records')).toBeTruthy();
    expect(view.getByText('Selected record')).toBeTruthy();
  });
});
