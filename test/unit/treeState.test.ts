/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const { TreeExplorer, valueViewerText } = await import('../../src/webview/Tree.js');
const { api: mockedApi } = await import('../../src/webview/api.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Value presentation', () => {
  it('decodes standard JSON string escapes for display', () => {
    const node: TreeNodeSummary = {
      pointer: '/message', key: 'message', type: 'string', preview: 'message',
      raw: '"line\\nnext\\t\\"quoted\\"\\\\path\\u263a"', childCount: 0, hasChildren: false,
    };
    expect(valueViewerText(node)).toBe('line\nnext\t"quoted"\\path☺');
  });

  it('formats containers without rounding unsafe integer literals', () => {
    const node: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'object', preview: '{2 properties}',
      raw: '{"id":900719925474099312345,"enabled":true}', childCount: 2, hasChildren: true,
    };
    expect(valueViewerText(node)).toBe('{\n  "id": 900719925474099312345,\n  "enabled": true\n}');
  });
});

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

  it('updates an applied value in place without replacing the tree root prop', async () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'number', preview: '1', raw: '1', childCount: 0, hasChildren: false,
    };
    const updated: TreeNodeSummary = { ...root, preview: '2', raw: '2' };
    const loadChildren = vi.fn(async (): Promise<TreeChildrenResult> => ({
      parentPointer: '', parent: updated, offset: 0, total: 0, children: [],
    }));
    const onEdit = vi.fn(async () => undefined);
    const view = render(React.createElement(TreeExplorer, { root, loadChildren, editable: true, onEdit }));

    expect(screen.queryByLabelText('JSON value')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit value' }));
    fireEvent.change(screen.getByLabelText('JSON value'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /apply value/i }));

    await waitFor(() => expect(view.container.querySelector('.node-preview')?.textContent).toBe('2'));
    expect(screen.queryByLabelText('JSON value')).toBeNull();
    expect(onEdit).toHaveBeenCalledWith({ kind: 'set', path: [], value: 2 });
    expect(loadChildren).toHaveBeenCalledWith('', 0, 200);
    expect(root.raw).toBe('1');
  });

  it('adds a property and refreshes only the edited container page', async () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'object', preview: '{0 properties}', raw: '{}', childCount: 0, hasChildren: false,
    };
    const child: TreeNodeSummary = {
      pointer: '/newProperty', key: 'newProperty', type: 'null', preview: 'null', raw: 'null', childCount: 0, hasChildren: false,
    };
    const updatedRoot: TreeNodeSummary = {
      ...root, preview: '{1 property}', raw: '{"newProperty":null}', childCount: 1, hasChildren: true,
    };
    const loadChildren = vi.fn(async (): Promise<TreeChildrenResult> => ({
      parentPointer: '', parent: updatedRoot, offset: 0, total: 1, children: [child],
    }));
    const onEdit = vi.fn(async () => undefined);
    const view = render(React.createElement(TreeExplorer, { root, loadChildren, editable: true, onEdit }));

    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    await waitFor(() => expect(view.container.querySelector('.node-preview')?.textContent).toBe('{1 property}'));
    expect(onEdit).toHaveBeenCalledWith({ kind: 'add', path: ['newProperty'], value: null });
    expect(loadChildren).toHaveBeenCalledWith('', 0, 200);

    fireEvent.click(view.container.querySelector('button.twisty')!);
    await screen.findByText('newProperty');
  });

  it('opens the selected value in a full-screen value viewer and restores with Escape', async () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'object', preview: '{1 property}', raw: '{"message":"hello"}', childCount: 1, hasChildren: true,
    };
    const view = render(React.createElement(TreeExplorer, {
      root,
      loadChildren: vi.fn(async () => ({ parentPointer: '', parent: root, offset: 0, total: 0, children: [] })),
      editable: false,
    }));

    fireEvent.click(view.getByRole('button', { name: 'View value full screen' }));
    const dialog = screen.getByRole('dialog', { name: 'Value viewer for /' });
    expect(dialog.textContent).toContain('"message": "hello"');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Value viewer for /' })).toBeNull());
    view.unmount();
  });

  it('resizes the unified value panel with the keyboard and persists its height', () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'JSON', type: 'string', preview: 'hello', raw: '"hello"', childCount: 0, hasChildren: false,
    };
    render(React.createElement(TreeExplorer, {
      root,
      loadChildren: vi.fn(async () => ({ parentPointer: '', parent: root, offset: 0, total: 0, children: [] })),
      editable: true,
    }));

    const resizeHandle = screen.getByRole('separator', { name: 'Resize value panel' });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('220');
    fireEvent.keyDown(resizeHandle, { key: 'ArrowDown' });
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('228');
    expect(mockedApi.updateState).toHaveBeenCalledWith({ valueViewerHeight: 228 });

    fireEvent.doubleClick(resizeHandle);
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('220');
    expect(screen.getAllByText('Value')).toHaveLength(1);
    expect(document.querySelector('.edit-section')).toBeNull();
  });

  it('gives JSONL record trees and Inspectors equal default widths with independent persistence', () => {
    const root: TreeNodeSummary = {
      pointer: '', key: 'Record', type: 'object', preview: '{0 properties}', raw: '{}', childCount: 0, hasChildren: false,
    };
    render(React.createElement(TreeExplorer, {
      root,
      physicalLine: 7,
      loadChildren: vi.fn(async () => ({ parentPointer: '', parent: root, offset: 0, total: 0, children: [] })),
      editable: false,
    }));

    const resizeHandle = screen.getByRole('separator', { name: 'Resize JSON tree and inspector' });
    const jqPath = screen.getByLabelText('jq path');
    expect(jqPath.tagName).toBe('CODE');
    expect(jqPath.getAttribute('tabindex')).toBe('0');
    expect(resizeHandle.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(mockedApi.updateState).toHaveBeenCalledWith({ jsonlTreePanePercent: 52 });
  });
});
