import React, { useEffect, useState } from 'react';
import type { DocumentBootstrap, WorkerEvent } from '../shared/types.js';
import { api, type NotificationKind } from './api.js';
import { Icon } from './Icons.js';
import { JsonView } from './JsonView.js';
import { JsonlView } from './JsonlView.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<DocumentBootstrap>();
  const [event, setEvent] = useState<WorkerEvent>();
  const [notification, setNotification] = useState<{ message: string; kind: NotificationKind }>();

  useEffect(() => {
    const removeBootstrap = api.onBootstrap((next) => {
      setBootstrap(next);
      setEvent(undefined);
    });
    const removeDocumentState = api.onDocumentState((dirty) => {
      setBootstrap((current) => {
        if (!current) return current;
        if (dirty) return { ...current, dirty: true };
        const { dirty: _dirty, ...clean } = current;
        return clean;
      });
    });
    const removeEvent = api.onWorkerEvent(setEvent);
    const removeNotification = api.onNotification((message, kind) => setNotification({ message, kind }));
    api.ready();
    return () => { removeBootstrap(); removeDocumentState(); removeEvent(); removeNotification(); };
  }, []);

  if (!bootstrap) return <div className="loading-screen">
    <div className="loading-card">
      <div className="loading-mark"><Icon name="braces" size={20} /></div>
      <div><strong>Preparing your data</strong><span>Opening high-performance preview…</span></div>
      <div className="spinner" />
    </div>
  </div>;
  const result = bootstrap.openResult;
  const modeLabel = bootstrap.mode === 'editable' ? 'Editable' : bootstrap.mode === 'readonly' ? 'Read-only' : 'Safe preview';
  const jsonlEditLimit = Math.min(bootstrap.settings.editableMaxBytes, 10 * 1024 * 1024);
  const jsonlReadOnlyReason = !bootstrap.editable
    ? bootstrap.fileSize > jsonlEditLimit
      ? `This file is larger than the ${formatBytes(jsonlEditLimit)} JSONL edit limit and is open read-only.`
      : 'This document requires byte-preserving streaming and is open read-only.'
    : undefined;

  return <main className="app-shell">
    <header className="document-header">
      <div className={`document-mark kind-${bootstrap.kind}`} aria-hidden="true"><Icon name="braces" size={18} /></div>
      <div className="document-identity">
        <div className="document-title-line">
          <div className="document-name" title={bootstrap.uri}>{bootstrap.name}</div>
          {bootstrap.dirty ? <span className="dirty-indicator" title="Unsaved changes"><span />Unsaved</span> : null}
        </div>
        <div className="document-meta">
          <span className="format-label">{bootstrap.kind.toUpperCase()}</span>
          <span className={`mode-label mode-${bootstrap.mode}`}><span className="mode-dot" />{modeLabel}</span>
          <span className="meta-separator" aria-hidden="true" />
          <span className="file-size">{formatBytes(bootstrap.fileSize)}</span>
        </div>
      </div>
      <div className="header-actions">
        <button className="subtle-button" onClick={() => api.command({ type: 'refresh' })}><Icon name="refresh" />Refresh</button>
        <button className="subtle-button" onClick={() => api.command({ type: 'openAsText' })}><Icon name="fileCode" />Open as text</button>
      </div>
    </header>
    {notification && <div className={`banner ${notification.kind === 'external' ? 'warning' : 'error'}`} role="alert">
      <span className="banner-icon"><Icon name={notification.kind === 'external' ? 'warning' : 'error'} /></span>
      <span>{notification.message}</span>
      {notification.kind !== 'error' && <button className="banner-action" onClick={() => api.command({ type: 'refresh' })}><Icon name="refresh" />Refresh</button>}
      <button className="icon-button ghost-button" aria-label="Dismiss" title="Dismiss" onClick={() => setNotification(undefined)}><Icon name="close" /></button>
    </div>}
    {bootstrap.mode === 'fallback' && <section className="fallback-view">
      <div className="fallback-card">
        <div className="fallback-illustration"><Icon name="warning" size={24} /></div>
        <div className="eyebrow">Safe preview</div>
        <h2>Structured preview was limited</h2>
        <p>{bootstrap.fallbackReason}</p>
        <div className="button-row"><button className="primary" onClick={() => api.command({ type: 'openAsText' })}><Icon name="fileCode" />Open as text</button><button onClick={() => api.command({ type: 'refresh' })}><Icon name="refresh" />Try again</button></div>
      </div>
      <div className="preview-card"><div className="preview-card-title"><Icon name="fileCode" />Truncated source preview</div><pre>{bootstrap.fallbackPreview}</pre></div>
    </section>}
    {bootstrap.mode !== 'fallback' && !result && <section className="structured-loading" aria-live="polite">
      <div className="structured-loading-card">
        <div className="loading-orbit" aria-hidden="true"><Icon name="braces" size={22} /><span /></div>
        <div className="eyebrow">Isolated worker</div>
        <h2>Building the JSON tree</h2>
        <p>The editor is ready while {formatBytes(bootstrap.fileSize)} of JSON is parsed safely in the background.</p>
        <div className="indeterminate-progress"><span /></div>
        <div className="loading-hint"><span className="status-orb success" />VS Code remains responsive</div>
      </div>
    </section>}
    {bootstrap.mode !== 'fallback' && result?.kind === 'json' && <JsonView key={`${bootstrap.sessionId}:json`} result={result} editable={bootstrap.editable} />}
    {bootstrap.mode !== 'fallback' && result?.kind === 'jsonl' && <JsonlView key={`${bootstrap.sessionId}:jsonl`} result={result} editable={bootstrap.editable} pageSize={bootstrap.settings.pageSize} {...(jsonlReadOnlyReason ? { readOnlyReason: jsonlReadOnlyReason } : {})} {...(event ? { workerEvent: event } : {})} />}
  </main>;
}
