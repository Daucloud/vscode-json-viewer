import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FilterLiteral,
  JsonlOpenResult,
  JsonlPageResult,
  JsonlQueryResult,
  JsonlQuerySpec,
  JsonlRow,
  StructuredFilter,
  TreeChildrenResult,
  WorkerEvent,
} from '../shared/types.js';
import type { ViewerEdit } from '../shared/webviewProtocol.js';
import { api, RequestError } from './api.js';
import { Icon } from './Icons.js';
import { ResizableSplit } from './ResizableSplit.js';
import { TreeExplorer } from './Tree.js';

const HEADER_HEIGHT = 34;
const ROW_HEIGHT = 30;
const LINE_COLUMN_WIDTH = 86;

function cellText(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  return String(value);
}

function literalFromText(input: string): FilterLiteral {
  const trimmed = input.trim();
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { kind: 'number', value: trimmed };
  if (trimmed === 'true' || trimmed === 'false') return { kind: 'boolean', value: trimmed === 'true' };
  if (trimmed === 'null') return { kind: 'null', value: null };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return { kind: 'string', value: parsed };
  } catch {
    // Unquoted input is intentionally treated as a string.
  }
  return { kind: 'string', value: input };
}

function rowClass(row: JsonlRow | undefined, selected: boolean): string {
  return `table-row ${row ? `row-${row.status}` : 'row-loading'}${selected ? ' selected' : ''}`;
}

function cellClass(value: unknown): string {
  if (value === null) return 'type-null';
  if (typeof value === 'number') return 'cell-number type-number';
  if (typeof value === 'boolean') return 'cell-boolean type-boolean';
  return '';
}

function hasQueryDraft(text: string, pointer: string, operation: string, sortPointer: string): boolean {
  return Boolean(text.trim() || (pointer.trim() && operation !== 'none') || sortPointer.trim());
}

export function JsonlView({
  result,
  editable,
  pageSize,
  workerEvent,
}: {
  result: JsonlOpenResult;
  editable: boolean;
  pageSize: number;
  workerEvent?: WorkerEvent;
}): React.JSX.Element {
  const persisted = api.state();
  const [fields, setFields] = useState(result.fields);
  const [rows, setRows] = useState<Map<number, JsonlRow>>(() => new Map(result.initialRows.map((row, index) => [index, row])));
  const [total, setTotal] = useState(result.recordCount ?? result.initialRows.length);
  const [indexReady, setIndexReady] = useState(result.indexReady);
  const [queryId, setQueryId] = useState('default');
  const queryIdRef = useRef(queryId);
  const [selected, setSelected] = useState<JsonlRow | undefined>(() => result.initialRows.find((row) => row.physicalLine === persisted.selectedPhysicalLine));
  const [rowRoot, setRowRoot] = useState<TreeChildrenResult>();
  const [rowTreeLoading, setRowTreeLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<{ task: string; ratio: number; records: number; matches?: number }>();
  const [runningRequest, setRunningRequest] = useState<string>();
  const runningRequestRef = useRef<string | undefined>(undefined);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(persisted.columnWidths ?? {});
  const [textQuery, setTextQuery] = useState(persisted.queryText ?? '');
  const [filterPointer, setFilterPointer] = useState(persisted.filterPointer ?? '');
  const [filterOperation, setFilterOperation] = useState(persisted.filterOperation ?? 'none');
  const [filterValue, setFilterValue] = useState(persisted.filterValue ?? '');
  const [sortPointer, setSortPointer] = useState(persisted.sortPointer ?? '');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(persisted.sortDirection ?? 'asc');
  const [queryNeedsRun, setQueryNeedsRun] = useState(() => hasQueryDraft(
    persisted.queryText ?? '', persisted.filterPointer ?? '', persisted.filterOperation ?? 'none', persisted.sortPointer ?? '',
  ));
  const loadingPages = useRef(new Set<string>());
  const rowTreeRequest = useRef<string | undefined>(undefined);
  const selectionGeneration = useRef(0);
  const queryGeneration = useRef(0);
  const rowNavigationGeneration = useRef(0);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const pendingRowFocus = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollTop = useRef(persisted.tableScrollTop);

  const cancelRowTreeRequest = useCallback((): void => {
    const request = rowTreeRequest.current;
    rowTreeRequest.current = undefined;
    if (request) void api.request({ type: 'cancel', targetRequestId: request }).catch(() => undefined);
  }, []);

  useEffect(() => { queryIdRef.current = queryId; }, [queryId]);
  useEffect(() => {
    const target = pendingScrollTop.current;
    if (target === undefined || !scrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = target;
      if (Math.abs(element.scrollTop - target) < 1 || indexReady) pendingScrollTop.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [indexReady, total]);
  useEffect(() => {
    queryGeneration.current++;
    selectionGeneration.current++;
    if (runningRequestRef.current) void api.request({ type: 'cancel', targetRequestId: runningRequestRef.current }).catch(() => undefined);
    cancelRowTreeRequest();
    runningRequestRef.current = undefined;
    rowTreeRequest.current = undefined;
    loadingPages.current.clear();
    rowNavigationGeneration.current++;
    setRunningRequest(undefined);
    setRowTreeLoading(false);
    setProgress(undefined);
    setFields(result.fields);
    setRows(new Map(result.initialRows.map((row, index) => [index, row])));
    setTotal(result.recordCount ?? result.initialRows.length);
    setIndexReady(result.indexReady);
    setQueryId('default');
    queryIdRef.current = 'default';
    setQueryNeedsRun(hasQueryDraft(
      api.state().queryText ?? '', api.state().filterPointer ?? '', api.state().filterOperation ?? 'none', api.state().sortPointer ?? '',
    ));
    setSelected(undefined);
    setRowRoot(undefined);
  }, [cancelRowTreeRequest, result]);

  useEffect(() => {
    if (!workerEvent) return;
    if (workerEvent.event === 'indexReady') {
      setIndexReady(true);
      setTotal(workerEvent.recordCount);
      setFields(workerEvent.fields);
      setProgress(undefined);
    } else if (workerEvent.event === 'progress') {
      if (workerEvent.task === 'query' && workerEvent.requestId !== runningRequestRef.current) return;
      setProgress({
        task: workerEvent.task,
        ratio: workerEvent.totalBytes > 0 ? workerEvent.scannedBytes / workerEvent.totalBytes : 0,
        records: workerEvent.records,
        ...(workerEvent.matches !== undefined ? { matches: workerEvent.matches } : {}),
      });
    } else if (workerEvent.event === 'warning') {
      setError(workerEvent.message);
    }
  }, [workerEvent]);

  const loadPage = useCallback(async (offset: number, forQuery = queryIdRef.current): Promise<JsonlPageResult | undefined> => {
    const aligned = Math.max(0, Math.floor(offset / pageSize) * pageSize);
    const key = `${forQuery}:${aligned}`;
    if (loadingPages.current.has(key)) return undefined;
    loadingPages.current.add(key);
    try {
      const response = await api.request<JsonlPageResult>({ type: 'jsonl/page', queryId: forQuery, offset: aligned, limit: pageSize });
      if (queryIdRef.current !== response.queryId) return response;
      setTotal(response.total);
      setRows((previous) => {
        const next = new Map(previous);
        response.rows.forEach((row, index) => next.set(response.offset + index, row));
        if (next.size > pageSize * 20) {
          for (const position of next.keys()) {
            if (Math.abs(position - aligned) > pageSize * 10) next.delete(position);
          }
        }
        return next;
      });
      return response;
    } catch (caught) {
      if (!(caught instanceof RequestError && caught.failure.code === 'CANCELLED')) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      loadingPages.current.delete(key);
    }
    return undefined;
  }, [pageSize]);

  const vertical = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const horizontal = useVirtualizer({
    horizontal: true,
    count: fields.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => columnWidths[fields[index] ?? ''] ?? 180,
    overscan: 2,
    getItemKey: (index) => fields[index] ?? index,
  });
  const visibleRows = vertical.getVirtualItems();
  const rangeKey = visibleRows.length > 0 ? `${visibleRows[0]!.index}:${visibleRows[visibleRows.length - 1]!.index}:${queryId}` : queryId;
  useEffect(() => {
    if (visibleRows.length === 0) return;
    const pages = new Set(visibleRows.map((item) => Math.floor(item.index / pageSize) * pageSize));
    for (const page of pages) void loadPage(page, queryId);
    // rangeKey is a compact signal from the virtualizer's currently visible range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  useEffect(() => { horizontal.measure(); }, [columnWidths, horizontal]);

  const selectRow = async (row: JsonlRow): Promise<void> => {
    selectionGeneration.current++;
    cancelRowTreeRequest();
    setSelected(row);
    api.updateState({ selectedPhysicalLine: row.physicalLine });
    setRowRoot(undefined);
    if (row.status !== 'valid') {
      setRowTreeLoading(false);
      return;
    }
    setRowTreeLoading(true);
    const operation = api.requestWithId<TreeChildrenResult>({ type: 'jsonl/treeChildren', physicalLine: row.physicalLine, pointer: '', offset: 0, limit: 200 });
    rowTreeRequest.current = operation.requestId;
    try {
      const root = await operation.promise;
      if (rowTreeRequest.current === operation.requestId) setRowRoot(root);
    } catch (caught) {
      if (rowTreeRequest.current === operation.requestId && !(caught instanceof RequestError && caught.failure.code === 'CANCELLED')) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (rowTreeRequest.current === operation.requestId) {
        rowTreeRequest.current = undefined;
        setRowTreeLoading(false);
      }
    }
  };

  const focusRowAfterRender = useCallback((index: number): void => {
    pendingRowFocus.current = index;
    vertical.scrollToIndex(index, { align: 'auto' });
  }, [vertical]);

  const rowAt = useCallback(async (index: number, query = queryIdRef.current): Promise<JsonlRow | undefined> => {
    if (index < 0) return undefined;
    const existing = rows.get(index);
    if (existing) return existing;
    const page = await loadPage(index, query);
    if (!page || page.queryId !== query || queryIdRef.current !== query) return undefined;
    return page.rows.find((_row, offset) => page.offset + offset === index);
  }, [loadPage, rows]);

  const handleTableKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, index: number, row: JsonlRow | undefined): void => {
    if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void selectRow(row);
      return;
    }
    let target: number | undefined;
    if (event.key === 'ArrowDown') target = Math.min(total - 1, index + 1);
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1);
    else if (event.key === 'PageDown') target = Math.min(total - 1, index + Math.max(1, visibleRows.length - 1));
    else if (event.key === 'PageUp') target = Math.max(0, index - Math.max(1, visibleRows.length - 1));
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = Math.max(0, total - 1);
    if (target === undefined || target === index || total <= 0) return;
    event.preventDefault();
    const generation = ++rowNavigationGeneration.current;
    void rowAt(target).then((next) => {
      if (rowNavigationGeneration.current !== generation || !next) return;
      focusRowAfterRender(target);
      void selectRow(next);
    });
  }, [focusRowAfterRender, rowAt, selectRow, total, visibleRows.length]);

  useEffect(() => {
    const index = pendingRowFocus.current;
    if (index === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      rowRefs.current.get(index)?.focus();
      if (rowRefs.current.has(index)) pendingRowFocus.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rows, selected, total]);

  useEffect(() => {
    const physicalLine = api.state().selectedPhysicalLine;
    if (!physicalLine) return;
    const generation = selectionGeneration.current;
    void loadPage(physicalLine - 1, 'default').then((page) => {
      if (selectionGeneration.current !== generation) return;
      const row = page?.rows.find((candidate) => candidate.physicalLine === physicalLine);
      if (row) void selectRow(row);
    });
    // Restore selection only when a document bootstrap is replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const buildSpec = (): JsonlQuerySpec => {
    let filter: StructuredFilter | undefined;
    if (filterPointer && filterOperation !== 'none') {
      if (filterOperation === 'exists') filter = { op: 'exists', pointer: filterPointer };
      else if (filterOperation === 'isNull') filter = { op: 'isNull', pointer: filterPointer };
      else if (filterOperation === 'contains') filter = { op: 'contains', pointer: filterPointer, value: filterValue, caseSensitive: false };
      else filter = {
        op: 'compare',
        pointer: filterPointer,
        comparator: filterOperation as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte',
        value: literalFromText(filterValue),
      };
    }
    return {
      ...(textQuery ? { text: textQuery, caseSensitive: false } : {}),
      ...(filter ? { filter } : {}),
      ...(sortPointer ? { sort: { pointer: sortPointer, direction: sortDirection } } : {}),
    };
  };

  const runQuery = async (): Promise<void> => {
    if (filterOperation !== 'none' && !filterPointer.trim()) {
      setError('Enter a JSON Pointer before choosing a field condition.');
      setQueryNeedsRun(true);
      return;
    }
    const generation = ++queryGeneration.current;
    const previousRequest = runningRequestRef.current;
    if (previousRequest) void api.request({ type: 'cancel', targetRequestId: previousRequest }).catch(() => undefined);
    runningRequestRef.current = undefined;
    cancelRowTreeRequest();
    selectionGeneration.current++;
    setRowTreeLoading(false);
    setError(undefined);
    const nextId = crypto.randomUUID();
    const operation = api.requestWithId<JsonlQueryResult>({ type: 'jsonl/query', queryId: nextId, spec: buildSpec() });
    runningRequestRef.current = operation.requestId;
    setRunningRequest(operation.requestId);
    api.updateState({ queryText: textQuery, filterPointer, filterOperation, filterValue, sortPointer, sortDirection });
    try {
      const response = await operation.promise;
      if (queryGeneration.current !== generation) return;
      const effectiveId = response.queryId;
      queryIdRef.current = effectiveId;
      setQueryId(effectiveId);
      setRows(new Map());
      setTotal(response.matchedRows);
      setSelected(undefined);
      setRowRoot(undefined);
      setQueryNeedsRun(false);
      await loadPage(0, effectiveId);
      setProgress(undefined);
    } catch (caught) {
      if (queryGeneration.current === generation && !(caught instanceof RequestError && caught.failure.code === 'CANCELLED')) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (queryGeneration.current === generation) {
        runningRequestRef.current = undefined;
        setRunningRequest(undefined);
      }
    }
  };

  const resetQuery = async (): Promise<void> => {
    queryGeneration.current++;
    const requestToCancel = runningRequestRef.current;
    if (requestToCancel) void api.request({ type: 'cancel', targetRequestId: requestToCancel }).catch(() => undefined);
    runningRequestRef.current = undefined;
    cancelRowTreeRequest();
    selectionGeneration.current++;
    rowNavigationGeneration.current++;
    setRunningRequest(undefined);
    setProgress(undefined);
    setTextQuery(''); setFilterPointer(''); setFilterOperation('none'); setFilterValue(''); setSortPointer('');
    setQueryNeedsRun(false);
    api.updateState({ queryText: '', filterPointer: '', filterOperation: 'none', filterValue: '', sortPointer: '' });
    queryIdRef.current = 'default';
    setQueryId('default');
    loadingPages.current.clear();
    setRows(new Map(result.initialRows.map((row, index) => [index, row])));
    setTotal(result.recordCount ?? result.initialRows.length);
    setSelected(undefined);
    setRowRoot(undefined);
    setRowTreeLoading(false);
    await loadPage(0, 'default');
  };

  const resizeColumn = (field: string, event: React.PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const resizeHandle = event.currentTarget;
    const startX = event.clientX;
    const initial = columnWidths[field] ?? 180;
    let finalWidth = initial;
    const move = (moveEvent: PointerEvent): void => {
      finalWidth = Math.max(80, Math.min(800, initial + moveEvent.clientX - startX));
      setColumnWidths((previous) => ({ ...previous, [field]: finalWidth }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (resizeHandle instanceof HTMLElement && resizeHandle.hasPointerCapture(event.pointerId)) {
        resizeHandle.releasePointerCapture(event.pointerId);
      }
      api.updateState({ columnWidths: { ...(api.state().columnWidths ?? {}), [field]: finalWidth } });
    };
    if (resizeHandle instanceof HTMLElement && resizeHandle.setPointerCapture) {
      try { resizeHandle.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in older webviews. */ }
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  };

  const resizeColumnByKeyboard = (field: string, event: React.KeyboardEvent<HTMLSpanElement>): void => {
    const current = columnWidths[field] ?? 180;
    const step = event.shiftKey ? 40 : 8;
    let next: number | undefined;
    if (event.key === 'ArrowLeft') next = current - step;
    else if (event.key === 'ArrowRight') next = current + step;
    else if (event.key === 'Home') next = 80;
    else if (event.key === 'End') next = 800;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const width = Math.max(80, Math.min(800, next));
    setColumnWidths((previous) => ({ ...previous, [field]: width }));
    api.updateState({ columnWidths: { ...(api.state().columnWidths ?? {}), [field]: width } });
  };

  const tableWidth = LINE_COLUMN_WIDTH + horizontal.getTotalSize();
  const columnItems = horizontal.getVirtualItems();
  const selectedRoot = rowRoot?.parent;
  const editRow = async (edit: ViewerEdit): Promise<void> => {
    await api.request({ type: 'edit', edit });
  };

  return <div className="document-view jsonl-view">
    <section className="query-panel" aria-label="JSONL query controls">
      <div className="query-primary">
          <label className="query-control query-search">
            <span className="control-label">Search records</span>
          <div className="input-with-icon"><Icon name="search" /><input aria-label="Full-text search" placeholder="Text in raw lines" value={textQuery} onChange={(event) => { setTextQuery(event.target.value); setQueryNeedsRun(true); }} onKeyDown={(event) => { if (event.key === 'Enter' && !runningRequest) { event.preventDefault(); void runQuery(); } }} /></div>
        </label>
        <label className="query-control query-field">
          <span className="control-label">Field pointer</span>
          <div className="input-with-icon"><Icon name="filter" /><input list="jsonl-fields" aria-label="Filter field JSON Pointer" placeholder="e.g. /user/id" value={filterPointer} onChange={(event) => { setFilterPointer(event.target.value); setQueryNeedsRun(true); }} onKeyDown={(event) => { if (event.key === 'Enter' && !runningRequest) { event.preventDefault(); void runQuery(); } }} /></div>
        </label>
        <datalist id="jsonl-fields">{fields.map((field) => <option value={field} key={field} />)}</datalist>
        <label className="query-control query-operation">
          <span className="control-label">Condition</span>
          <select aria-label="Filter operation" value={filterOperation} onChange={(event) => { setFilterOperation(event.target.value); setQueryNeedsRun(true); }}>
            <option value="none">No filter</option><option value="eq">Equals</option><option value="ne">Not equal</option>
            <option value="contains">Contains</option><option value="gt">Greater than</option><option value="gte">At least</option>
            <option value="lt">Less than</option><option value="lte">At most</option><option value="exists">Exists</option><option value="isNull">Is null</option>
          </select>
        </label>
        <label className="query-control query-value">
          <span className="control-label">Value</span>
          <input aria-label="Filter value" placeholder="Value to match" disabled={filterOperation === 'none' || filterOperation === 'exists' || filterOperation === 'isNull'} value={filterValue} onChange={(event) => { setFilterValue(event.target.value); setQueryNeedsRun(true); }} onKeyDown={(event) => { if (event.key === 'Enter' && !runningRequest) { event.preventDefault(); void runQuery(); } }} />
        </label>
        <div className="query-run">
          <span className="control-label" aria-hidden="true">Query</span>
          <button className="primary run-button" disabled={Boolean(runningRequest)} onClick={() => void runQuery()}>{runningRequest ? <><span className="button-spinner" />Scanning</> : <><Icon name="sparkle" />Run query</>}</button>
        </div>
      </div>
      <div className="query-secondary">
        <div className="sort-controls">
          <span className="inline-control-label"><Icon name="sort" />Sort</span>
          <select aria-label="Sort field" value={sortPointer} onChange={(event) => { setSortPointer(event.target.value); setQueryNeedsRun(true); }}>
            <option value="">No field selected</option>{fields.map((field) => <option value={field} key={field}>{field}</option>)}
          </select>
          <select aria-label="Sort direction" disabled={!sortPointer} value={sortDirection} onChange={(event) => { setSortDirection(event.target.value as 'asc' | 'desc'); setQueryNeedsRun(true); }}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
        </div>
        <span className="spacer" />
        {runningRequest && <button className="ghost-button" onClick={() => api.command({ type: 'cancel', targetRequestId: runningRequest })}><Icon name="close" />Cancel scan</button>}
        {queryId !== 'default' && <button className="ghost-button" onClick={() => void resetQuery()}><Icon name="reset" />Reset query</button>}
        {editable && <div className="toolbar-actions edit-actions">
          <span className="toolbar-divider" />
          <button className="icon-button ghost-button" title="Undo" aria-label="Undo" onClick={() => api.command({ type: 'undo' })}><Icon name="undo" /></button>
          <button className="icon-button ghost-button" title="Redo" aria-label="Redo" onClick={() => api.command({ type: 'redo' })}><Icon name="redo" /></button>
          <button className="primary" onClick={() => api.command({ type: 'save' })}><Icon name="save" />Save</button>
          <button onClick={() => api.command({ type: 'saveAs' })}><Icon name="saveAs" />Save As…</button>
        </div>}
      </div>
    </section>
    {progress && <div className="progress-line"><div style={{ width: `${Math.min(100, progress.ratio * 100)}%` }} /><span className="progress-icon"><span className="button-spinner" /></span><span><strong>{progress.task}</strong> · {(progress.ratio * 100).toFixed(1)}% · {progress.records.toLocaleString()} rows{progress.matches !== undefined ? ` · ${progress.matches.toLocaleString()} matches` : ''}</span></div>}
    {!indexReady && <div className="banner info"><span className="banner-icon"><Icon name="info" /></span><span><strong>Records are ready.</strong> A disk-backed line index is being built in the background.</span></div>}
    {error && <div className="banner error" role="alert"><span className="banner-icon"><Icon name="error" /></span><span>{error}</span><button className="icon-button ghost-button" aria-label="Dismiss" title="Dismiss" onClick={() => setError(undefined)}><Icon name="close" /></button></div>}
    <ResizableSplit
      className="jsonl-layout"
      defaultPercent={72}
      initialPercent={persisted.jsonlTablePanePercent}
      minStart={420}
      minEnd={480}
      label="Resize records table and row details"
      onChange={(next) => api.updateState({ jsonlTablePanePercent: next })}
    >
      <section className="table-pane">
        <div className="table-summary">
          <span className="summary-title"><Icon name="table" /><strong>{total.toLocaleString()}</strong> records</span>
          <span className="summary-divider" />
          <span>{fields.length.toLocaleString()} sampled fields</span>
          <span className={`query-status ${queryId === 'default' ? '' : 'active'}${queryNeedsRun ? ' pending' : ''}`} title={queryNeedsRun ? 'The controls contain changes that are not applied yet.' : undefined}>{queryNeedsRun ? 'Query ready · run to apply' : queryId === 'default' ? 'All records' : 'Filtered result'}</span>
          <span className="spacer" />
          <span className={`index-state ${indexReady ? 'ready' : ''}`}><span className="status-orb" />{indexReady ? 'Indexed' : 'Indexing'}</span>
        </div>
        <div className="table-scroll" ref={scrollRef} role="grid" aria-label="JSONL records" aria-rowcount={total + 1} aria-colcount={fields.length + 1} aria-busy={!indexReady || Boolean(runningRequest)} onScroll={(event) => api.updateState({ tableScrollTop: event.currentTarget.scrollTop })}>
          <div className="table-space" style={{ width: tableWidth, height: vertical.getTotalSize() + HEADER_HEIGHT }}>
            <div className="table-header" role="row" aria-rowindex={1} style={{ width: tableWidth, height: HEADER_HEIGHT }}>
              <div className="line-cell header-cell" role="columnheader" style={{ width: LINE_COLUMN_WIDTH }}><span>Line</span></div>
              {columnItems.map((column) => {
                const field = fields[column.index]!;
                return <div className="header-cell field-cell" role="columnheader" key={column.key} title={field} style={{ left: LINE_COLUMN_WIDTH + column.start, width: column.size }}>
                  <span>{field}</span><span className="column-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${field} column`} tabIndex={0}
                    onPointerDown={(event) => resizeColumn(field, event)} onKeyDown={(event) => resizeColumnByKeyboard(field, event)} />
                </div>;
              })}
            </div>
            {visibleRows.map((item) => {
              const row = rows.get(item.index);
              return <div role="row" aria-rowindex={item.index + 2} aria-selected={row?.physicalLine === selected?.physicalLine} tabIndex={row ? (row.physicalLine === selected?.physicalLine || !selected ? 0 : -1) : -1} ref={(element) => {
                  if (element) rowRefs.current.set(item.index, element);
                  else rowRefs.current.delete(item.index);
                }} key={item.key} className={rowClass(row, row?.physicalLine === selected?.physicalLine)}
                style={{ transform: `translateY(${item.start + HEADER_HEIGHT}px)`, height: item.size, width: tableWidth }}
                onKeyDown={(event) => handleTableKeyDown(event, item.index, row)}
                onClick={() => { if (row) void selectRow(row); }}>
                <div className="line-cell" style={{ width: LINE_COLUMN_WIDTH }} title={row?.diagnostic?.message}>{row ? <>{row.status !== 'valid' && <Icon name="warning" size={13} />}<span>{row.physicalLine}</span></> : <span className="cell-skeleton" />}</div>
                {columnItems.map((column) => {
                  const field = fields[column.index]!;
                  const value = row?.cells[field];
                  const text = row ? cellText(value) : '';
                  return <div role="cell" className={`field-cell ${cellClass(value)}`} key={column.key} title={text || row?.diagnostic?.message} style={{ left: LINE_COLUMN_WIDTH + column.start, width: column.size }}>{row ? text || (column.index === 0 && row.status !== 'valid' ? row.raw : '') : <span className="cell-skeleton" />}</div>;
                })}
              </div>;
            })}
          </div>
          {total === 0 && <div className="table-empty"><div className="empty-icon"><Icon name="search" size={20} /></div><strong>No matching records</strong><span>Adjust the query or reset the current filters.</span></div>}
        </div>
      </section>
      <aside className="row-detail">
        {!selected && <div className="empty-state"><div className="empty-illustration"><Icon name="braces" size={22} /></div><div><strong>Select a record</strong><span>Its complete JSON tree will appear here.</span></div></div>}
        {selected && <div className="row-detail-header">
          <div className="record-identity"><span className="eyebrow">Selected record</span><div className="record-title">Line {selected.physicalLine.toLocaleString()}<span className={`status-pill status-${selected.status}`}><span className="status-orb" />{selected.status}</span></div></div>
          <button className="subtle-button" onClick={() => api.command({ type: 'openAsText', physicalLine: selected.physicalLine, ...(selected.diagnostic?.column !== undefined ? { column: selected.diagnostic.column } : {}) })}><Icon name="external" />Open source</button>
        </div>}
        {rowTreeLoading && <div className="empty-state loading-state"><div className="spinner" /><div><strong>Loading record</strong><span>Building its JSON tree…</span></div></div>}
        {selected && selected.status !== 'valid' && <div className="diagnostic-panel"><div className="diagnostic-heading"><span className="diagnostic-icon"><Icon name="warning" /></span><div><span className="eyebrow">Record diagnostic</span><strong>{selected.diagnostic?.message}</strong></div></div><pre>{selected.raw}</pre></div>}
        {selected && selectedRoot && <TreeExplorer
          key={`${selected.physicalLine}:${selectedRoot.preview}`}
          root={selectedRoot}
          editable={editable}
          physicalLine={selected.physicalLine}
          loadChildren={(pointer, offset, limit) => api.request<TreeChildrenResult>({ type: 'jsonl/treeChildren', physicalLine: selected.physicalLine, pointer, offset, limit })}
          {...(persisted.expandedRow ? { initialExpanded: persisted.expandedRow } : {})}
          onExpandedChange={(paths) => api.updateState({ expandedRow: paths })}
          onEdit={editRow}
        />}
      </aside>
    </ResizableSplit>
  </div>;
}
