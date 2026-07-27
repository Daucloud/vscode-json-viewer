/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TreeChildrenResult, TreeNodeSummary } from '../../src/shared/types.js';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize, getItemKey }: {
    count: number;
    estimateSize: () => number;
    getItemKey?: (index: number) => React.Key;
  }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: getItemKey?.(index) ?? index,
      start: index * estimateSize(),
      size: estimateSize(),
    })),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock('../../src/webview/api.js', () => ({
  api: {
    state: () => ({}),
    updateState: vi.fn(),
    command: vi.fn(),
    request: vi.fn(),
  },
}));

const { TreeExplorer } = await import('../../src/webview/Tree.js');

describe('TreeExplorer state', () => {
  it('keeps loaded and expanded row data when persisted props change during a resize render', async () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'object', preview: '{1}', childCount: 1, hasChildren: true,
    };
    const nested: TreeNodeSummary = {
      pointer: '/nested', key: 'nested', type: 'object', preview: '{1}', childCount: 1, hasChildren: true,
    };
    const value: TreeNodeSummary = {
      pointer: '/nested/value', key: 'value', type: 'number', preview: '1', raw: '1', childCount: 0, hasChildren: false,
    };
    const loadChildren = vi.fn(async (pointer: string): Promise<TreeChildrenResult> => pointer === ''
      ? { parentPointer: '', parent: root, offset: 0, total: 1, children: [nested] }
      : { parentPointer: '/nested', parent: nested, offset: 0, total: 1, children: [value] });
    const onExpandedChange = vi.fn();
    const props = { root, loadChildren, editable: false, initialExpanded: [] as string[], onExpandedChange };
    const view = render(React.createElement(TreeExplorer, props));

    fireEvent.click(view.container.querySelectorAll('button.twisty')[0]!);
    await screen.findByText('nested');
    fireEvent.click(view.container.querySelectorAll('button.twisty')[1]!);
    await screen.findByText('value');

    view.rerender(React.createElement(TreeExplorer, {
      ...props,
      initialExpanded: ['', '/nested'],
    }));

    await waitFor(() => expect(screen.getByText('value')).toBeTruthy());
    expect(loadChildren).toHaveBeenCalledTimes(2);
  });
});
