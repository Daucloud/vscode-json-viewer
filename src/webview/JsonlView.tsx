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
import { api } from './api.js';
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
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(persisted.columnWidths ?? {});
  const [textQuery, setTextQuery] = useState(persisted.queryText ?? '');
  const [filterPointer, setFilterPointer] = useState(persisted.filterPointer ?? '');
  const [filterOperation, setFilterOperation] = useState(persisted.filterOperation ?? 'none');
  const [filterValue, setFilterValue] = useState(persisted.filterValue ?? '');
  const [sortPointer, setSortPointer] = useState(persisted.sortPointer ?? '');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(persisted.sortDirection ?? 'asc');
  const loadingPages = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollTop = useRef(persisted.tableScrollTop);

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
    setFields(result.fields);
    setRows(new Map(result.initialRows.map((row, index) => [index, row])));
    setTotal(result.recordCount ?? result.initialRows.length);
    setIndexReady(result.indexReady);
    setQueryId('default');
    queryIdRef.current = 'default';
    setSelected(undefined);
    setRowRoot(undefined);
  }, [result]);

  useEffect(() => {
    if (!workerEvent) return;
    if (workerEvent.event === 'indexReady') {
      setIndexReady(true);
      setTotal(workerEvent.recordCount);
      setFields(workerEvent.fields);
      setProgress(undefined);
    } else if (workerEvent.event === 'progress') {
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
      setError(caught instanceof Error ? caught.message : String(caught));
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
    setSelected(row);
    api.updateState({ selectedPhysicalLine: row.physicalLine });
    setRowRoot(undefined);
    if (row.status !== 'valid') return;
    setRowTreeLoading(true);
    try {
      const root = await api.request<TreeChildrenResult>({ type: 'jsonl/treeChildren', physicalLine: row.physicalLine, pointer: '', offset: 0, limit: 200 });
      setRowRoot(root);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRowTreeLoading(false);
    }
  };

  useEffect(() => {
    const physicalLine = api.state().selectedPhysicalLine;
    if (!physicalLine) return;
    void loadPage(physicalLine - 1, 'default').then((page) => {
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
    setError(undefined);
    const nextId = crypto.randomUUID();
    const operation = api.requestWithId<JsonlQueryResult>({ type: 'jsonl/query', queryId: nextId, spec: buildSpec() });
    setRunningRequest(operation.requestId);
    api.updateState({ queryText: textQuery, filterPointer, filterOperation, filterValue, sortPointer, sortDirection });
    try {
      const response = await operation.promise;
      const effectiveId = response.queryId;
      queryIdRef.current = effectiveId;
      setQueryId(effectiveId);
      setRows(new Map());
      setTotal(response.matchedRows);
      setSelected(undefined);
      setRowRoot(undefined);
      await loadPage(0, effectiveId);
      setProgress(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningRequest(undefined);
    }
  };

  const resetQuery = async (): Promise<void> => {
    setTextQuery(''); setFilterPointer(''); setFilterOperation('none'); setFilterValue(''); setSortPointer('');
    api.updateState({ queryText: '', filterPointer: '', filterOperation: 'none', filterValue: '', sortPointer: '' });
    queryIdRef.current = 'default';
    setQueryId('default');
    setRows(new Map(result.initialRows.map((row, index) => [index, row])));
    setTotal(result.recordCount ?? result.initialRows.length);
    await loadPage(0, 'default');
  };

  const resizeColumn = (field: string, event: React.PointerEvent): void => {
    event.preventDefault();
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
      api.updateState({ columnWidths: { ...(api.state().columnWidths ?? {}), [field]: finalWidth } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
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
          <div className="input-with-icon"><Icon name="search" /><input aria-label="Full-text search" placeholder="Text in raw lines" value={textQuery} onChange={(event) => setTextQuery(event.target.value)} /></div>
        </label>
        <label className="query-control query-field">
          <span className="control-label">Field pointer</span>
          <div className="input-with-icon"><Icon name="filter" /><input list="jsonl-fields" aria-label="Filter field JSON Pointer" placeholder="e.g. /user/id" value={filterPointer} onChange={(event) => setFilterPointer(event.target.value)} /></div>
        </label>
        <datalist id="jsonl-fields">{fields.map((field) => <option value={field} key={field} />)}</datalist>
        <label className="query-control query-operation">
          <span className="control-label">Condition</span>
          <select aria-label="Filter operation" value={filterOperation} onChange={(event) => setFilterOperation(event.target.value)}>
            <option value="none">No filter</option><option value="eq">Equals</option><option value="ne">Not equal</option>
            <option value="contains">Contains</option><option value="gt">Greater than</option><option value="gte">At least</option>
            <option value="lt">Less than</option><option value="lte">At most</option><option value="exists">Exists</option><option value="isNull">Is null</option>
          </select>
        </label>
        <label className="query-control query-value">
          <span className="control-label">Value</span>
          <input aria-label="Filter value" placeholder="Value to match" disabled={filterOperation === 'none' || filterOperation === 'exists' || filterOperation === 'isNull'} value={filterValue} onChange={(event) => setFilterValue(event.target.value)} />
        </label>
        <div className="query-run">
          <span className="control-label" aria-hidden="true">Query</span>
          <button className="primary run-button" disabled={Boolean(runningRequest)} onClick={() => void runQuery()}>{runningRequest ? <><span className="button-spinner" />Scanning</> : <><Icon name="sparkle" />Run query</>}</button>
        </div>
      </div>
      <div className="query-secondary">
        <div className="sort-controls">
          <span className="inline-control-label"><Icon name="sort" />Sort</span>
          <select aria-label="Sort field" value={sortPointer} onChange={(event) => setSortPointer(event.target.value)}>
            <option value="">No field selected</option>{fields.map((field) => <option value={field} key={field}>{field}</option>)}
          </select>
          <select aria-label="Sort direction" disabled={!sortPointer} value={sortDirection} onChange={(event) => setSortDirection(event.target.value as 'asc' | 'desc')}><option value="asc">Ascending</option><option value="desc">Descending</option></select>
        </div>
        <span className="spacer" />
        {runningRequest && <button className="ghost-button" onClick={() => void api.request({ type: 'cancel', targetRequestId: runningRequest })}><Icon name="close" />Cancel scan</button>}
        {queryId !== 'default' && <button className="ghost-button" onClick={() => void resetQuery()}><Icon name="reset" />Reset query</button>}
        {editable && <div className="toolbar-actions edit-actions">
          <span className="toolbar-divider" />
          <button className="icon-button ghost-button" title="Undo" aria-label="Undo" onClick={() => void api.request({ type: 'undo' })}><Icon name="undo" /></button>
          <button className="icon-button ghost-button" title="Redo" aria-label="Redo" onClick={() => void api.request({ type: 'redo' })}><Icon name="redo" /></button>
          <button className="primary" onClick={() => void api.request({ type: 'save' })}><Icon name="save" />Save</button>
          <button onClick={() => void api.request({ type: 'saveAs' })}><Icon name="saveAs" />Save As…</button>
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
          <span className={`query-status ${queryId === 'default' ? '' : 'active'}`}>{queryId === 'default' ? 'All records' : 'Filtered result'}</span>
          <span className="spacer" />
          <span className={`index-state ${indexReady ? 'ready' : ''}`}><span className="status-orb" />{indexReady ? 'Indexed' : 'Indexing'}</span>
        </div>
        <div className="table-scroll" ref={scrollRef} onScroll={(event) => api.updateState({ tableScrollTop: event.currentTarget.scrollTop })}>
          <div className="table-space" style={{ width: tableWidth, height: vertical.getTotalSize() + HEADER_HEIGHT }}>
            <div className="table-header" style={{ width: tableWidth, height: HEADER_HEIGHT }}>
              <div className="line-cell header-cell" style={{ width: LINE_COLUMN_WIDTH }}><span>Line</span></div>
              {columnItems.map((column) => {
                const field = fields[column.index]!;
                return <div className="header-cell field-cell" key={column.key} title={field} style={{ left: LINE_COLUMN_WIDTH + column.start, width: column.size }}>
                  <span>{field}</span><span className="column-resizer" onPointerDown={(event) => resizeColumn(field, event)} />
                </div>;
              })}
            </div>
            {visibleRows.map((item) => {
              const row = rows.get(item.index);
              return <div role="row" tabIndex={row ? 0 : -1} key={item.key} className={rowClass(row, row?.physicalLine === selected?.physicalLine)}
                style={{ transform: `translateY(${item.start + HEADER_HEIGHT}px)`, height: item.size, width: tableWidth }}
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
          <button className="subtle-button" onClick={() => void api.request({ type: 'openAsText', physicalLine: selected.physicalLine, ...(selected.diagnostic?.column !== undefined ? { column: selected.diagnostic.column } : {}) })}><Icon name="external" />Open source</button>
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
