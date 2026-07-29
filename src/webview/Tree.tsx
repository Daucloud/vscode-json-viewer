import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { jqPathFromPath, joinPointer, parentPointer, pathFromPointer, pointerFromPath } from '../shared/pointer.js';
import type { JsonPath } from '../shared/pointer.js';
import type { TreeChildrenResult, TreeNodeSummary } from '../shared/types.js';
import type { ViewerEdit } from '../shared/webviewProtocol.js';
import { api } from './api.js';
import { Icon } from './Icons.js';
import { ResizableSplit } from './ResizableSplit.js';

interface Entry {
  node: TreeNodeSummary;
  children?: TreeNodeSummary[];
  startOffset?: number;
  total?: number;
  loading?: boolean;
  error?: string;
}

type VisibleItem =
  | { kind: 'node'; node: TreeNodeSummary; depth: number }
  | { kind: 'more'; parent: TreeNodeSummary; depth: number; offset: number; label: string }
  | { kind: 'status'; parent: TreeNodeSummary; depth: number; label: string };

// Expanding every node in a very large document would eagerly materialize a
// huge number of summaries in the webview and make the virtualizer's row walk
// expensive. Keep the action useful for normal documents while preserving the
// viewer's responsiveness for large collections.
const EXPAND_ALL_NODE_LIMIT = 20_000;
const EXPAND_PROGRESS_INTERVAL = 24;

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export interface TreeExplorerProps {
  root: TreeNodeSummary;
  loadChildren: (pointer: string, offset: number, limit: number) => Promise<TreeChildrenResult>;
  loadContainingChild?: (parentPointer: string, childPointer: string, limit: number) => Promise<TreeChildrenResult>;
  editable: boolean;
  physicalLine?: number;
  initialExpanded?: string[];
  initialSelected?: string;
  focusPointer?: string;
  onExpandedChange?: (paths: string[]) => void;
  onSelectedChange?: (pointer: string) => void;
  onEdit?: (edit: ViewerEdit) => Promise<void>;
}

function typeGlyph(node: TreeNodeSummary): string {
  if (node.type === 'object') return '{}';
  if (node.type === 'array') return '[]';
  if (node.type === 'string') return 'S';
  if (node.type === 'number') return '#';
  if (node.type === 'boolean') return 'B';
  return '∅';
}

function typedPath(pointer: string, entries: ReadonlyMap<string, Entry>): JsonPath {
  const segments = pathFromPointer(pointer);
  const result: JsonPath = [];
  let parent = '';
  for (const segment of segments) {
    result.push(entries.get(parent)?.node.type === 'array' ? Number(segment) : String(segment));
    parent = joinPointer(parent, segment);
  }
  return result;
}

function parseValue(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(`Enter a valid JSON value: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function valueViewerText(node: TreeNodeSummary): string {
  const raw = node.raw;
  if (raw === undefined) return node.preview;
  if (node.type !== 'object' && node.type !== 'array') return raw;
  try { return JSON.stringify(JSON.parse(raw) as unknown, null, 2); }
  catch { return raw; }
}

async function copyFromWebview(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // VS Code versions and remote setups differ in whether the webview origin
    // receives Clipboard API permission. Fall back to the legacy synchronous
    // path while the click still owns user activation, then use the extension
    // host as the final fallback below.
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  textarea.style.top = '0';
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand('copy'); }
  catch { copied = false; }
  textarea.remove();
  previousFocus?.focus();
  return copied;
}

function Inspector({
  selected,
  entries,
  editable,
  physicalLine,
  onEdit,
}: {
  selected: TreeNodeSummary;
  entries: ReadonlyMap<string, Entry>;
  editable: boolean;
  physicalLine?: number;
  onEdit?: (edit: ViewerEdit) => Promise<void>;
}): React.JSX.Element {
  const [valueText, setValueText] = useState(selected.raw ?? selected.preview);
  const [newKey, setNewKey] = useState(selected.key);
  const [childKey, setChildKey] = useState('newProperty');
  const [childValue, setChildValue] = useState('null');
  const [error, setError] = useState<string>();
  const [copying, setCopying] = useState<'path' | 'value'>();
  const [copyNotice, setCopyNotice] = useState<{ kind: 'success' | 'error'; message: string }>();
  const [valueViewerFullscreen, setValueViewerFullscreen] = useState(false);
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const parent = selected.pointer === '' ? undefined : entries.get(parentPointer(selected.pointer) ?? '')?.node;

  useEffect(() => {
    setValueText(selected.raw ?? selected.preview);
    setNewKey(selected.key);
    setError(undefined);
    setCopyNotice(undefined);
    setValueViewerFullscreen(false);
  }, [selected]);

  useEffect(() => () => {
    if (copyNoticeTimer.current !== undefined) window.clearTimeout(copyNoticeTimer.current);
  }, []);

  useEffect(() => {
    if (!valueViewerFullscreen) return;
    document.body.classList.add('value-viewer-open');
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setValueViewerFullscreen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.classList.remove('value-viewer-open');
    };
  }, [valueViewerFullscreen]);

  const runEdit = async (edit: ViewerEdit): Promise<void> => {
    if (!onEdit) return;
    setError(undefined);
    try { await onEdit(edit); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const path = typedPath(selected.pointer, entries);
  const jqPath = jqPathFromPath(path);
  const displayedValue = valueViewerText(selected);
  const withLine = physicalLine === undefined ? {} : { physicalLine };
  const isContainer = selected.type === 'object' || selected.type === 'array';
  const applyValue = (): void => {
    try {
      void runEdit({ kind: 'set', path, value: parseValue(valueText), ...withLine });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const addValue = (): void => {
    try {
      const childPath: JsonPath = selected.type === 'array' ? [...path, selected.childCount] : [...path, childKey];
      void runEdit({ kind: 'add', path: childPath, value: parseValue(childValue), ...(selected.type === 'array' ? { insertArray: true } : {}), ...withLine });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const copy = async (kind: 'path' | 'value', text: string): Promise<void> => {
    setCopying(kind);
    setCopyNotice(undefined);
    if (copyNoticeTimer.current !== undefined) window.clearTimeout(copyNoticeTimer.current);
    try {
      if (!await copyFromWebview(text)) await api.request({ type: 'copy', text });
      setCopyNotice({ kind: 'success', message: kind === 'path' ? 'Path copied to clipboard.' : 'Value copied to clipboard.' });
      copyNoticeTimer.current = window.setTimeout(() => setCopyNotice(undefined), 1800);
    } catch (caught) {
      setCopyNotice({ kind: 'error', message: `Copy failed: ${caught instanceof Error ? caught.message : String(caught)}` });
    } finally {
      setCopying(undefined);
    }
  };

  return <aside className="inspector" aria-label="JSON inspector">
    <div className="inspector-header">
      <span className={`inspector-type-mark type-${selected.type}`}>{typeGlyph(selected)}</span>
      <div className="inspector-heading">
        <span className="eyebrow">Inspector</span>
        <h2 title={selected.key}>{selected.pointer === '' ? 'Document root' : selected.key}</h2>
      </div>
      <span className={`type-pill type-${selected.type}`}>{selected.type}</span>
    </div>
    <div className="inspector-content">
      <section className="inspector-section pointer-section">
        <span className="meta-label">jq path</span>
        <div className="pointer-field">
          <code title={jqPath}>{jqPath}</code>
          <button className="copy-path-button" disabled={copying !== undefined} title="Copy jq path" aria-label="Copy jq path" onClick={() => void copy('path', jqPath)}>
            {copying === 'path' ? <span className="button-spinner" /> : <Icon name="copy" />}<span>{copying === 'path' ? 'Copying' : 'Copy'}</span>
          </button>
        </div>
      </section>

      <div className="inspector-stats">
        <div className="stat-card"><span>Type</span><strong className={`type-${selected.type}`}>{selected.type}</strong></div>
        <div className="stat-card"><span>Children</span><strong>{selected.childCount.toLocaleString()}</strong></div>
      </div>

      <section className="inspector-section value-section">
        <div className="value-viewer-heading">
          <span className="meta-label">Value viewer</span>
          <button className="icon-button ghost-button" title="View value full screen" aria-label="View value full screen" onClick={() => setValueViewerFullscreen(true)}><Icon name="maximize" /></button>
        </div>
        <pre className={`value-viewer type-${selected.type}`} title={selected.raw === undefined ? selected.preview : undefined}>{displayedValue}</pre>
        {selected.raw === undefined && <span className="value-viewer-note"><Icon name="info" />This value is too large to transfer inline. The structured tree remains fully available.</span>}
      </section>

      {valueViewerFullscreen && createPortal(<section className="value-viewer-fullscreen" role="dialog" aria-modal="true" aria-label={`Value viewer for ${selected.pointer || '/'}`}>
        <header className="value-viewer-fullscreen-header">
          <div className="value-viewer-title"><span className={`inspector-type-mark type-${selected.type}`}>{typeGlyph(selected)}</span><div><span className="eyebrow">Value viewer</span><strong title={jqPath}>{jqPath}</strong></div></div>
          <div className="value-viewer-fullscreen-actions">
            <button disabled={selected.raw === undefined || copying !== undefined} onClick={() => void copy('value', selected.raw ?? selected.preview)}><Icon name="copy" />Copy value</button>
            <button className="primary" autoFocus onClick={() => setValueViewerFullscreen(false)}><Icon name="restore" />Exit full screen</button>
          </div>
        </header>
        <pre className={`value-viewer-fullscreen-content type-${selected.type}`}>{displayedValue}</pre>
      </section>, document.body)}

      <div className="inspector-actions">
        <button disabled={selected.raw === undefined || copying !== undefined} title={selected.raw === undefined ? 'This value exceeds the safe inline copy limit.' : 'Copy the complete JSON value'}
          onClick={() => void copy('value', selected.raw ?? selected.preview)}>{copying === 'value' ? <><span className="button-spinner" />Copying</> : <><Icon name="copy" />Copy value</>}</button>
        <button onClick={() => api.command({ type: 'revealSource', path, ...(physicalLine ? { physicalLine } : {}) })}><Icon name="external" />Source</button>
      </div>
      {copyNotice && <div className={`copy-notice ${copyNotice.kind}`} role={copyNotice.kind === 'error' ? 'alert' : 'status'}><Icon name={copyNotice.kind === 'error' ? 'error' : 'check'} />{copyNotice.message}</div>}

      {editable && !isContainer && selected.raw !== undefined && <section className="edit-section">
        <div className="edit-section-title"><span className="edit-icon"><Icon name="braces" /></span><div><strong>Edit value</strong><span>Enter any valid JSON value</span></div></div>
        <label className="control-label" htmlFor="edit-value">JSON value</label>
        <textarea id="edit-value" rows={4} value={valueText} onChange={(event) => setValueText(event.target.value)} />
        <button className="primary" onClick={applyValue}><Icon name="check" />Apply value</button>
      </section>}
      {editable && !isContainer && selected.raw === undefined && <div className="inline-note"><Icon name="info" />This value is larger than the safe inline edit limit. Open the source text to edit it.</div>}

      {editable && parent?.type === 'object' && <section className="edit-section compact-edit-section">
        <div className="edit-section-title"><span className="edit-icon"><Icon name="braces" /></span><div><strong>Rename property</strong><span>Update this object key</span></div></div>
        <label className="control-label" htmlFor="rename-key">Property name</label>
        <input id="rename-key" value={newKey} onChange={(event) => setNewKey(event.target.value)} />
        <button onClick={() => void runEdit({ kind: 'rename', path, newKey, ...withLine })}>Rename</button>
      </section>}

      {editable && isContainer && <section className="edit-section">
        <div className="edit-section-title"><span className="edit-icon"><Icon name="plus" /></span><div><strong>Add {selected.type === 'array' ? 'item' : 'property'}</strong><span>Append a child to this {selected.type}</span></div></div>
        {selected.type === 'object' && <><label className="control-label" htmlFor="new-property-name">Property name</label><input id="new-property-name" value={childKey} onChange={(event) => setChildKey(event.target.value)} /></>}
        <label className="control-label" htmlFor="new-json-value">JSON value</label>
        <textarea id="new-json-value" rows={3} value={childValue} onChange={(event) => setChildValue(event.target.value)} />
        <button onClick={addValue}><Icon name="plus" />Add {selected.type === 'array' ? 'item' : 'property'}</button>
      </section>}

      {editable && selected.pointer !== '' && <button className="danger delete-button" onClick={() => void runEdit({ kind: 'delete', path, ...withLine })}><Icon name="trash" />Delete node</button>}
      {error && <div className="inline-error" role="alert"><Icon name="error" />{error}</div>}
    </div>
  </aside>;
}

export function TreeExplorer(props: TreeExplorerProps): React.JSX.Element {
  const [entries, setEntries] = useState<Map<string, Entry>>(() => new Map([[props.root.pointer, { node: props.root }]]));
  const entriesRef = useRef(entries);
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set(props.initialExpanded ?? []));
  const [selectedPointer, setSelectedPointer] = useState(props.initialSelected ?? props.root.pointer);
  const [depth, setDepth] = useState(2);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollTop = useRef(props.physicalLine === undefined ? api.state().jsonScrollTop : undefined);
  const [expandingAll, setExpandingAll] = useState(false);
  const [expansionStatus, setExpansionStatus] = useState<string>();
  const expansionCancelRequested = useRef(false);
  const expansionGeneration = useRef(0);

  const commitEntries = useCallback((next: Map<string, Entry>): void => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  useEffect(() => {
    expansionGeneration.current++;
    expansionCancelRequested.current = true;
    const next = new Map<string, Entry>([[props.root.pointer, { node: props.root }]]);
    commitEntries(next);
    setExpandedState(new Set(props.initialExpanded ?? []));
    setSelectedPointer(props.initialSelected ?? props.root.pointer);
    // `initialExpanded` and `initialSelected` are bootstrap snapshots. A
    // container resize can re-render the parent with a newer persisted array;
    // treating that as a new tree would discard all lazily loaded children.
    // The root identity (or the caller's key) is the document boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root, commitEntries]);

  useEffect(() => {
    const paths = [...(props.initialExpanded ?? [])].sort((left, right) => left.split('/').length - right.split('/').length);
    let cancelled = false;
    void (async () => {
      for (const pointer of paths) {
        if (cancelled) return;
        const entry = entriesRef.current.get(pointer);
        if (entry?.node.hasChildren && !entry.children) {
          try { await loadPage(pointer, 0); } catch { return; }
        }
      }
    })();
    return () => { cancelled = true; };
    // Restore only when a new root/initial state arrives, not on each lazy page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.root]);

  const setExpanded = useCallback((next: Set<string>): void => {
    setExpandedState(next);
    props.onExpandedChange?.([...next].slice(0, 2000));
  }, [props]);

  const storeChildren = useCallback((pointer: string, fallback: Entry, result: TreeChildrenResult): void => {
    const latest = entriesRef.current.get(pointer) ?? fallback;
    const existing = latest.children ?? [];
    const existingStart = latest.startOffset ?? 0;
    let children: TreeNodeSummary[];
    let startOffset: number;
    if (existing.length > 0 && result.offset === existingStart + existing.length) {
      children = [...existing, ...result.children];
      startOffset = existingStart;
    } else if (existing.length > 0 && result.offset + result.children.length === existingStart) {
      children = [...result.children, ...existing];
      startOffset = result.offset;
    } else {
      children = result.children;
      startOffset = result.offset;
    }
    const next = new Map(entriesRef.current);
    next.set(pointer, { node: result.parent ?? latest.node, children, startOffset, total: result.total, loading: false });
    for (const child of result.children) {
      const previous = next.get(child.pointer);
      next.set(child.pointer, previous ? { ...previous, node: child } : { node: child });
    }
    commitEntries(next);
  }, [commitEntries]);

  const replaceNodeReferences = useCallback((entriesToUpdate: Map<string, Entry>, node: TreeNodeSummary): void => {
    for (const [pointer, entry] of entriesToUpdate) {
      if (!entry.children?.some((child) => child.pointer === node.pointer)) continue;
      entriesToUpdate.set(pointer, {
        ...entry,
        children: entry.children.map((child) => child.pointer === node.pointer ? node : child),
      });
    }
  }, []);

  const replaceTreePage = useCallback((pointer: string, result: TreeChildrenResult): void => {
    const next = new Map(entriesRef.current);
    const previous = next.get(pointer);
    const node = result.parent
      ? { ...result.parent, key: previous?.node.key ?? result.parent.key }
      : previous?.node;
    if (!node) throw new Error('The edited tree node is no longer available.');

    next.set(pointer, {
      node,
      children: result.children,
      startOffset: result.offset,
      total: result.total,
      loading: false,
    });
    replaceNodeReferences(next, node);
    for (const child of result.children) {
      const existing = next.get(child.pointer);
      next.set(child.pointer, existing ? { ...existing, node: child } : { node: child });
    }
    commitEntries(next);
  }, [commitEntries, replaceNodeReferences]);

  const removeTreeBranch = useCallback((pointer: string): void => {
    const prefix = `${pointer}/`;
    const next = new Map(entriesRef.current);
    for (const key of next.keys()) {
      if (key === pointer || key.startsWith(prefix)) next.delete(key);
    }
    commitEntries(next);
  }, [commitEntries]);

  const loadPage = useCallback(async (pointer: string, offset: number): Promise<TreeChildrenResult> => {
    const current = entriesRef.current.get(pointer);
    if (!current) throw new Error('Tree node is no longer available.');
    const loading = new Map(entriesRef.current);
    const { error: _previousError, ...currentWithoutError } = current;
    loading.set(pointer, { ...currentWithoutError, loading: true });
    commitEntries(loading);
    try {
      const result = await props.loadChildren(pointer, offset, 200);
      storeChildren(pointer, current, result);
      return result;
    } catch (error) {
      const next = new Map(entriesRef.current);
      next.set(pointer, { ...current, loading: false, error: error instanceof Error ? error.message : String(error) });
      commitEntries(next);
      throw error;
    }
  }, [commitEntries, props, storeChildren]);

  const editAndRefresh = useCallback(async (edit: ViewerEdit): Promise<void> => {
    if (!props.onEdit) return;
    await props.onEdit(edit);

    const editedPointer = pointerFromPath(edit.path);
    if (edit.kind === 'set') {
      const result = await props.loadChildren(editedPointer, 0, 200);
      replaceTreePage(editedPointer, result);
      if (!result.parent?.hasChildren) {
        const nextExpanded = new Set(expanded);
        nextExpanded.delete(editedPointer);
        setExpanded(nextExpanded);
      }
      return;
    }

    const containerPointer = parentPointer(editedPointer) ?? '';
    const container = entriesRef.current.get(containerPointer);
    const offset = container?.startOffset ?? 0;
    const result = await props.loadChildren(containerPointer, offset, 200);
    if (edit.kind === 'delete' || edit.kind === 'rename') removeTreeBranch(editedPointer);
    replaceTreePage(containerPointer, result);

    if (edit.kind === 'delete') {
      setSelectedPointer(containerPointer);
      props.onSelectedChange?.(containerPointer);
      return;
    }
    if (edit.kind === 'rename') {
      const renamedPointer = pointerFromPath([...edit.path.slice(0, -1), edit.newKey]);
      const nextSelection = entriesRef.current.has(renamedPointer) ? renamedPointer : containerPointer;
      setSelectedPointer(nextSelection);
      props.onSelectedChange?.(nextSelection);
    }
  }, [expanded, props, removeTreeBranch, replaceTreePage, setExpanded]);

  const toggle = useCallback((node: TreeNodeSummary): void => {
    if (!node.hasChildren) return;
    const next = new Set(expanded);
    if (next.has(node.pointer)) next.delete(node.pointer);
    else {
      next.add(node.pointer);
      if (!entriesRef.current.get(node.pointer)?.children) void loadPage(node.pointer, 0);
    }
    setExpanded(next);
  }, [expanded, loadPage, setExpanded]);

  const expandDepth = useCallback(async (): Promise<void> => {
    const nextExpanded = new Set<string>();
    const frontier: Array<{ node: TreeNodeSummary; level: number }> = [{ node: props.root, level: 0 }];
    let frontierIndex = 0;
    let visited = 0;
    while (frontierIndex < frontier.length && visited < 2000) {
      const current = frontier[frontierIndex++]!;
      visited++;
      if (!current.node.hasChildren || current.level >= depth) continue;
      nextExpanded.add(current.node.pointer);
      let entry = entriesRef.current.get(current.node.pointer);
      if (!entry?.children) {
        await loadPage(current.node.pointer, 0);
        entry = entriesRef.current.get(current.node.pointer);
      }
      for (const child of entry?.children ?? []) frontier.push({ node: child, level: current.level + 1 });
    }
    setExpanded(nextExpanded);
  }, [depth, loadPage, props.root, setExpanded]);

  const expandAll = useCallback(async (): Promise<void> => {
    if (expandingAll) return;
    const limit = EXPAND_ALL_NODE_LIMIT;
    if (props.root.childCount > limit) {
      setExpansionStatus(`This document has more than ${limit.toLocaleString()} root children. Use Depth for a bounded expansion.`);
      return;
    }

    setExpandingAll(true);
    expansionCancelRequested.current = false;
    const generation = expansionGeneration.current;
    setExpansionStatus('Expanding all…');
    const nextExpanded = new Set<string>();
    const queue: TreeNodeSummary[] = [props.root];
    const seen = new Set<string>([props.root.pointer]);
    let queueIndex = 0;
    let stoppedAtLimit = false;
    let cancelledByUser = false;
    let processedContainers = 0;

    try {
      while (queueIndex < queue.length) {
        if (expansionCancelRequested.current || generation !== expansionGeneration.current) {
          cancelledByUser = true;
          break;
        }
        const node = queue[queueIndex++]!;
        if (!node.hasChildren) continue;
        // childCount is known from the worker, so reject a branch before
        // loading thousands of pages that cannot be shown safely at once.
        if (seen.size + node.childCount - 1 > limit) {
          stoppedAtLimit = true;
          break;
        }

        let entry = entriesRef.current.get(node.pointer);
        if (!entry?.children || (entry.startOffset ?? 0) > 0) {
          await loadPage(node.pointer, 0);
          entry = entriesRef.current.get(node.pointer);
        }
        let startOffset = entry?.startOffset ?? 0;
        let loadedCount = entry?.children?.length ?? 0;
        let total = entry?.total ?? node.childCount;
        if (seen.size + total - 1 > limit) {
          stoppedAtLimit = true;
          break;
        }
        while (startOffset + loadedCount < total) {
          if (expansionCancelRequested.current || generation !== expansionGeneration.current) {
            cancelledByUser = true;
            break;
          }
          const nextOffset = startOffset + loadedCount;
          await loadPage(node.pointer, nextOffset);
          entry = entriesRef.current.get(node.pointer);
          const nextStartOffset = entry?.startOffset ?? 0;
          const nextLoadedCount = entry?.children?.length ?? 0;
          if (nextStartOffset + nextLoadedCount <= nextOffset) break;
          startOffset = nextStartOffset;
          loadedCount = nextLoadedCount;
          total = entry?.total ?? total;
        }
        if (cancelledByUser) break;
        if (startOffset + loadedCount < total) {
          stoppedAtLimit = true;
          break;
        }

        nextExpanded.add(node.pointer);
        for (const child of entry?.children ?? []) {
          if (seen.has(child.pointer)) continue;
          seen.add(child.pointer);
          if (seen.size > limit) {
            stoppedAtLimit = true;
            break;
          }
          if (child.hasChildren) queue.push(child);
        }
        processedContainers++;
        if (processedContainers % EXPAND_PROGRESS_INTERVAL === 0) {
          setExpanded(new Set(nextExpanded));
          setExpansionStatus(`Expanding all… ${seen.size.toLocaleString()} nodes`);
          await yieldToBrowser();
        }
        if (stoppedAtLimit) break;
      }

      if (generation !== expansionGeneration.current) return;
      setExpanded(nextExpanded);
      setExpansionStatus(cancelledByUser
        ? `Expansion stopped after ${nextExpanded.size.toLocaleString()} containers.`
        : stoppedAtLimit
          ? `Expanded ${nextExpanded.size.toLocaleString()} containers; stopped at ${limit.toLocaleString()} nodes to keep the viewer responsive.`
          : `Expanded ${nextExpanded.size.toLocaleString()} containers.`);
    } catch (error) {
      if (generation !== expansionGeneration.current) return;
      setExpanded(nextExpanded);
      setExpansionStatus(`Expand all stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === expansionGeneration.current) setExpandingAll(false);
    }
  }, [expandingAll, loadPage, props.root, setExpanded]);

  const cancelExpandAll = useCallback((): void => {
    if (!expandingAll) return;
    expansionCancelRequested.current = true;
    setExpansionStatus('Stopping expansion…');
  }, [expandingAll]);

  useEffect(() => {
    if (!props.focusPointer) return;
    let cancelled = false;
    void (async () => {
      const target = props.focusPointer!;
      const segments = pathFromPointer(target);
      let parent = '';
      const nextExpanded = new Set(expanded);
      for (const segment of segments) {
        if (cancelled) return;
        nextExpanded.add(parent);
        const childPointer = joinPointer(parent, segment);
        let entry = entriesRef.current.get(parent);
        if (!entriesRef.current.has(childPointer) && props.loadContainingChild && entry) {
          const result = await props.loadContainingChild(parent, childPointer, 200);
          storeChildren(parent, entry, result);
          entry = entriesRef.current.get(parent);
        }
        while (!entriesRef.current.has(childPointer) && (entry?.startOffset ?? 0) + (entry?.children?.length ?? 0) < (entry?.total ?? Number.POSITIVE_INFINITY)) {
          await loadPage(parent, (entry?.startOffset ?? 0) + (entry?.children?.length ?? 0));
          entry = entriesRef.current.get(parent);
          if ((entry?.children?.length ?? 0) === 0) break;
        }
        parent = childPointer;
      }
      if (!cancelled && entriesRef.current.has(target)) {
        setExpanded(nextExpanded);
        setSelectedPointer(target);
        props.onSelectedChange?.(target);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
    // The effect intentionally follows a new search target, not every expansion change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusPointer]);

  const rows = useMemo<VisibleItem[]>(() => {
    const output: VisibleItem[] = [];
    const stack: Array<
      | { kind: 'node'; node: TreeNodeSummary; depth: number }
      | { kind: 'more'; parent: TreeNodeSummary; depth: number; offset: number; label: string }
      | { kind: 'status'; parent: TreeNodeSummary; depth: number; label: string }
    > = [{ kind: 'node', node: entries.get(props.root.pointer)?.node ?? props.root, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.kind === 'more') {
        output.push(current);
        continue;
      }
      if (current.kind === 'status') {
        output.push(current);
        continue;
      }
      output.push({ kind: 'node', node: current.node, depth: current.depth });
      if (!expanded.has(current.node.pointer)) continue;
      const entry = entries.get(current.node.pointer);
      const children = entry?.children ?? [];
      const startOffset = entry?.startOffset ?? 0;
      // Push trailing markers before children so the LIFO walk renders children first.
      if (entry?.error) stack.push({ kind: 'status', parent: current.node, depth: current.depth + 1, label: entry.error });
      else if (entry?.loading && !entry.children) stack.push({ kind: 'status', parent: current.node, depth: current.depth + 1, label: 'Loading…' });
      if ((entry?.total ?? children.length) > startOffset + children.length) stack.push({ kind: 'more', parent: current.node, depth: current.depth + 1, offset: startOffset + children.length, label: 'Load next 200…' });
      for (let index = children.length - 1; index >= 0; index--) stack.push({ kind: 'node', node: children[index]!, depth: current.depth + 1 });
      if (startOffset > 0) stack.push({ kind: 'more', parent: current.node, depth: current.depth + 1, offset: Math.max(0, startOffset - 200), label: 'Load previous 200…' });
    }
    return output;
  }, [entries, expanded, props.root]);

  useEffect(() => {
    const target = pendingScrollTop.current;
    if (props.physicalLine !== undefined || target === undefined || !scrollRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = target;
      if (Math.abs(element.scrollTop - target) < 1) pendingScrollTop.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.physicalLine, rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
    getItemKey: (index) => rows[index]?.kind === 'node' ? `n:${rows[index].node.pointer}` : `${rows[index]?.kind}:${index}`,
  });
  const selected = entries.get(selectedPointer)?.node ?? entries.get(props.root.pointer)?.node ?? props.root;
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusPointer = useRef<string | undefined>(undefined);

  const selectNode = useCallback((pointer: string, rowIndex?: number, focus = false): void => {
    setSelectedPointer(pointer);
    props.onSelectedChange?.(pointer);
    if (!focus) return;
    pendingFocusPointer.current = pointer;
    if (rowIndex !== undefined) virtualizer.scrollToIndex(rowIndex, { align: 'auto' });
  }, [props, virtualizer]);

  useEffect(() => {
    const pointer = pendingFocusPointer.current;
    if (pointer === undefined) return;
    const frame = window.requestAnimationFrame(() => {
      rowRefs.current.get(pointer)?.focus();
      if (rowRefs.current.has(pointer)) pendingFocusPointer.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rows, selectedPointer]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, row: Extract<VisibleItem, { kind: 'node' }>, rowIndex: number): void => {
    const node = row.node;
    let targetIndex: number | undefined;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      for (let index = rowIndex + direction; index >= 0 && index < rows.length; index += direction) {
        if (rows[index]?.kind === 'node') {
          targetIndex = index;
          break;
        }
      }
    } else if (event.key === 'Home' || event.key === 'End') {
      const direction = event.key === 'Home' ? 1 : -1;
      const start = event.key === 'Home' ? 0 : rows.length - 1;
      for (let index = start; index >= 0 && index < rows.length; index += direction) {
        if (rows[index]?.kind === 'node') {
          targetIndex = index;
          break;
        }
      }
    } else if (event.key === 'ArrowRight') {
      if (node.hasChildren && !expanded.has(node.pointer)) {
        event.preventDefault();
        toggle(node);
        return;
      }
      const next = rows[rowIndex + 1];
      if (node.hasChildren && expanded.has(node.pointer) && next?.kind === 'node' && next.depth > row.depth) {
        event.preventDefault();
        selectNode(next.node.pointer, rowIndex + 1, true);
        return;
      }
    } else if (event.key === 'ArrowLeft') {
      if (expanded.has(node.pointer)) {
        event.preventDefault();
        toggle(node);
        return;
      }
      const parent = parentPointer(node.pointer);
      if (parent !== undefined) {
        const parentIndex = rows.findIndex((candidate) => candidate.kind === 'node' && candidate.node.pointer === parent);
        if (parentIndex >= 0) {
          event.preventDefault();
          selectNode(parent, parentIndex, true);
          return;
        }
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (node.hasChildren) {
        event.preventDefault();
        toggle(node);
        return;
      }
    }
    if (targetIndex === undefined) return;
    const target = rows[targetIndex];
    if (target?.kind !== 'node') return;
    event.preventDefault();
    selectNode(target.node.pointer, targetIndex, true);
  }, [expanded, props, rows, selectNode, toggle]);

  const rowTree = props.physicalLine !== undefined;
  const defaultTreePanePercent = rowTree ? 56 : 68;

  return <ResizableSplit
    className={rowTree ? 'tree-explorer row-tree-explorer' : 'tree-explorer'}
    defaultPercent={defaultTreePanePercent}
    initialPercent={api.state().treePanePercent}
    minStart={rowTree ? 120 : 220}
    minEnd={rowTree ? 140 : 220}
    label="Resize JSON tree and inspector"
    onChange={(next) => api.updateState({ treePanePercent: next })}
  >
    <section className="tree-column">
      <div className="tree-toolbar" aria-busy={expandingAll}>
        <div className="tree-toolbar-group">
          <button className="ghost-button" disabled={expandingAll} title="Collapse every expanded node" aria-label="Collapse all" onClick={() => setExpanded(new Set())}><Icon name="collapse" /><span className="button-label">Collapse</span></button>
          <span className="toolbar-divider" />
          <label className="depth-control"><span className="depth-label">Depth</span><input className="depth-input" disabled={expandingAll} aria-label="Expansion depth" type="number" min={1} max={20} value={depth} onChange={(event) => setDepth(Math.max(1, Number(event.target.value)))} /></label>
          <button className="ghost-button" disabled={expandingAll} title={`Expand tree to depth ${depth}`} aria-label={`Expand tree to depth ${depth}`} onClick={() => void expandDepth()}><Icon name="expand" /><span className="button-label">Expand</span></button>
          {expandingAll
            ? <button className="ghost-button" title="Stop expanding the tree" aria-label="Stop expanding" onClick={cancelExpandAll}><Icon name="close" /><span className="button-label">Stop</span></button>
            : <button className="ghost-button" title="Expand every node within a safe size limit" aria-label="Expand all" onClick={() => void expandAll()}><Icon name="expandAll" /><span className="button-label">Expand all</span></button>}
        </div>
        <span className="spacer" />
        {expansionStatus && <span className="expand-status" role="status" title={expansionStatus}>{expandingAll && <span className="button-spinner" />}{expansionStatus}</span>}
        <span className="visible-count"><span className="status-orb" />{rows.length.toLocaleString()} visible</span>
      </div>
      <div className="tree-scroll" ref={scrollRef} role="tree" aria-label="JSON tree" aria-busy={expandingAll} onScroll={(event) => {
        if (props.physicalLine === undefined) api.updateState({ jsonScrollTop: event.currentTarget.scrollTop });
      }}>
        <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const style = { transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size };
            if (row.kind === 'status') return <div key={virtualRow.key} className="tree-row tree-status virtual-row" style={style}><span style={{ width: row.depth * 16 }} /><Icon name={row.label === 'Loading…' ? 'refresh' : 'error'} />{row.label}</div>;
            if (row.kind === 'more') return <button key={virtualRow.key} className="tree-row load-more virtual-row" style={{ ...style, paddingLeft: row.depth * 16 + 8 }} onClick={() => void loadPage(row.parent.pointer, row.offset)}><Icon name="plus" />{row.label}</button>;
            const node = row.node;
            return <div key={virtualRow.key} ref={(element) => {
                if (element) rowRefs.current.set(node.pointer, element);
                else rowRefs.current.delete(node.pointer);
              }} data-pointer={node.pointer} className={`tree-row virtual-row ${selected.pointer === node.pointer ? 'selected' : ''}`} style={style}
              role="treeitem" tabIndex={selected.pointer === node.pointer ? 0 : -1}
              aria-level={row.depth + 1} aria-selected={selected.pointer === node.pointer} aria-expanded={node.hasChildren ? expanded.has(node.pointer) : undefined}
              onKeyDown={(event) => handleTreeKeyDown(event, row, virtualRow.index)}
              onClick={() => selectNode(node.pointer)}
              onDoubleClick={() => toggle(node)}>
              <span className="indent" style={{ width: row.depth * 16 }} />
              <button className="twisty" aria-label={expanded.has(node.pointer) ? 'Collapse' : 'Expand'} disabled={!node.hasChildren} onClick={(event) => { event.stopPropagation(); toggle(node); }}>{node.hasChildren ? <Icon name={expanded.has(node.pointer) ? 'chevronDown' : 'chevronRight'} size={14} /> : <span className="leaf-dot" />}</button>
              <span className={`type-icon type-${node.type}`}>{typeGlyph(node)}</span>
              <span className="node-key" title={node.key}>{node.key}</span>
              <span className="node-separator">:</span>
              <span className={`node-preview type-${node.type}`} title={node.preview}>{node.preview}</span>
            </div>;
          })}
        </div>
      </div>
    </section>
    <Inspector selected={selected} entries={entries} editable={props.editable} {...(props.physicalLine ? { physicalLine: props.physicalLine } : {})} {...(props.onEdit ? { onEdit: editAndRefresh } : {})} />
  </ResizableSplit>;
}
