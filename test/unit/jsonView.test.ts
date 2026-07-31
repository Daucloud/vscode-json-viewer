/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonOpenResult, TreeSearchResult } from '../../src/shared/types.js';

vi.mock('../../src/webview/api.js', () => ({
  api: {
    state: vi.fn(() => ({})),
    updateState: vi.fn(),
    command: vi.fn(),
    request: vi.fn(),
    requestWithId: vi.fn(),
  },
  RequestError: class RequestError extends Error {
    constructor(readonly failure: { code: string; message: string }) {
      super(failure.message);
    }
  },
}));

vi.mock('../../src/webview/Tree.js', () => ({
  TreeExplorer: () => React.createElement('div', { 'data-testid': 'tree-explorer' }),
}));

const { JsonView } = await import('../../src/webview/JsonView.js');
const { api: mockedApi } = await import('../../src/webview/api.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('JSON search results', () => {
  it('places many matches in a dedicated keyboard-scrollable region', async () => {
    const matches: TreeSearchResult = {
      matches: Array.from({ length: 80 }, (_, index) => ({
        pointer: `/records/${index}`,
        key: String(index),
        type: 'number',
        preview: String(index),
      })),
      truncated: false,
      visited: 80,
    };
    vi.mocked(mockedApi.requestWithId).mockReturnValue({
      requestId: 'search-request',
      promise: Promise.resolve(matches),
    });
    const result: JsonOpenResult = {
      kind: 'json',
      root: { pointer: '', key: 'JSON', type: 'array', preview: '[80 items]', childCount: 80, hasChildren: true },
      parseMilliseconds: 1,
    };

    render(React.createElement(JsonView, { result, editable: false }));
    fireEvent.change(screen.getByLabelText('Search JSON'), { target: { value: 'record' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const region = await screen.findByRole('region', { name: 'Matching JSON paths' });
    await waitFor(() => expect(region.querySelectorAll('button')).toHaveLength(80));
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.classList.contains('search-result-list')).toBe(true);
  });
});
