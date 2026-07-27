import React, { useState } from 'react';
import type { JsonOpenResult, TreeChildrenResult, TreeSearchResult } from '../shared/types.js';
import type { ViewerEdit } from '../shared/webviewProtocol.js';
import { api } from './api.js';
import { Icon } from './Icons.js';
import { TreeExplorer } from './Tree.js';

export function JsonView({ result, editable }: { result: JsonOpenResult; editable: boolean }): React.JSX.Element {
  const persisted = api.state();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<TreeSearchResult>();
  const [searching, setSearching] = useState(false);
  const [searchRequest, setSearchRequest] = useState<string>();
  const [error, setError] = useState<string>();
  const [focusPointer, setFocusPointer] = useState<string | undefined>(persisted.selectedPointer);

  const search = async (): Promise<void> => {
    if (!query.trim()) {
      setMatches(undefined);
      return;
    }
    setSearching(true);
    setError(undefined);
    const operation = api.requestWithId<TreeSearchResult>({ type: 'json/search', query, limit: 1000 });
    setSearchRequest(operation.requestId);
    try {
      const response = await operation.promise;
      setMatches(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSearching(false);
      setSearchRequest(undefined);
    }
  };

  const edit = async (operation: ViewerEdit): Promise<void> => {
    await api.request({ type: 'edit', edit: operation });
  };

  return <div className="document-view">
    <div className="view-toolbar">
      <form className="search-box" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <div className="input-with-icon search-input"><Icon name="search" /><input aria-label="Search JSON" placeholder="Search keys and values" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <button className="primary" type="submit" disabled={searching}>{searching ? <><span className="button-spinner" />Searching</> : <><Icon name="search" />Search</>}</button>
        {searchRequest && <button type="button" onClick={() => void api.request({ type: 'cancel', targetRequestId: searchRequest })}><Icon name="close" />Cancel</button>}
      </form>
      <div className="parse-stat" title="Worker parse time"><span className="status-orb success" />Parsed in <strong>{result.parseMilliseconds.toFixed(0)} ms</strong></div>
      {editable && <div className="toolbar-actions">
        <button className="icon-button ghost-button" title="Undo" aria-label="Undo" onClick={() => void api.request({ type: 'undo' })}><Icon name="undo" /></button>
        <button className="icon-button ghost-button" title="Redo" aria-label="Redo" onClick={() => void api.request({ type: 'redo' })}><Icon name="redo" /></button>
        <span className="toolbar-divider" />
        <button className="primary" onClick={() => void api.request({ type: 'save' })}><Icon name="save" />Save</button>
        <button onClick={() => void api.request({ type: 'saveAs' })}><Icon name="saveAs" />Save As…</button>
      </div>}
    </div>
    {error && <div className="banner error" role="alert"><span className="banner-icon"><Icon name="error" /></span><span>{error}</span><button className="icon-button ghost-button" aria-label="Dismiss" onClick={() => setError(undefined)}><Icon name="close" /></button></div>}
    {matches && <section className="search-results" aria-label="Search results">
      <div className="search-results-summary"><span className="result-icon"><Icon name="search" /></span><div><strong>{matches.matches.length.toLocaleString()} matches{matches.truncated ? '+' : ''}</strong><span>Jump to a matching path</span></div></div>
      <div className="search-result-list">
        {matches.matches.slice(0, 100).map((match) => <button key={match.pointer} title={match.pointer || '/'} onClick={() => setFocusPointer(match.pointer)}>
          <span className="result-path">{match.pointer || '/'}</span><span className={`type-${match.type}`}>{match.preview}</span>
        </button>)}
      </div>
      <button className="icon-button ghost-button" aria-label="Close search results" title="Close results" onClick={() => setMatches(undefined)}><Icon name="close" /></button>
    </section>}
    <TreeExplorer
      root={result.root}
      editable={editable}
      loadChildren={(pointer, offset, limit) => api.request<TreeChildrenResult>({ type: 'json/children', pointer, offset, limit })}
      loadContainingChild={(parentPointer, childPointer, limit) => api.request<TreeChildrenResult>({ type: 'json/childPage', parentPointer, childPointer, limit })}
      {...(persisted.expandedJson ? { initialExpanded: persisted.expandedJson } : {})}
      {...(persisted.selectedPointer !== undefined ? { initialSelected: persisted.selectedPointer } : {})}
      {...(focusPointer !== undefined ? { focusPointer } : {})}
      onExpandedChange={(paths) => api.updateState({ expandedJson: paths })}
      onSelectedChange={(pointer) => api.updateState({ selectedPointer: pointer })}
      onEdit={edit}
    />
  </div>;
}
