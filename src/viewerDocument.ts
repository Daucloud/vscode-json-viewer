import { createHash, randomUUID } from 'node:crypto';
import { open, rename, stat as nodeStat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import * as vscode from 'vscode';
import { readSettings } from './configuration.js';
import { pointerFromPath, type JsonPath } from './shared/pointer.js';
import type {
  DocumentBootstrap,
  DocumentKind,
  DocumentMode,
  IndexReadyEvent,
  SessionOpenResult,
  SourceSignature,
  WorkerEvent,
} from './shared/types.js';
import type { ViewerAction, ViewerEdit, ViewerEditResult } from './shared/webviewProtocol.js';
import type { WorkerResponseData, WorkerSource } from './worker/protocol.js';
import { WorkerClient, WorkerClientError } from './workerClient.js';

interface TextDelta {
  start: number;
  removed: string;
  inserted: string;
}

export interface ViewerDocumentEdit {
  label: string;
  undo: () => Thenable<void>;
  redo: () => Thenable<void>;
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkerClientError('INVALID_UTF8', error instanceof Error ? error.message : 'The file is not valid UTF-8.');
  }
}

function makeDelta(before: string, after: string): TextDelta {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let suffix = 0;
  while (
    suffix < shortest - start
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) suffix++;
  return {
    start,
    removed: before.slice(start, before.length - suffix),
    inserted: after.slice(start, after.length - suffix),
  };
}

function applyDelta(text: string, delta: TextDelta, reverse: boolean): string {
  const expected = reverse ? delta.inserted : delta.removed;
  const replacement = reverse ? delta.removed : delta.inserted;
  if (text.slice(delta.start, delta.start + expected.length) !== expected) {
    throw new Error('The document changed outside the expected undo/redo sequence.');
  }
  return `${text.slice(0, delta.start)}${replacement}${text.slice(delta.start + expected.length)}`;
}

async function atomicWrite(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  if (uri.scheme !== 'file') {
    await vscode.workspace.fs.writeFile(uri, bytes);
    return;
  }
  const temporary = join(dirname(uri.fsPath), `.${basename(uri.fsPath)}.fast-json-${randomUUID()}.tmp`);
  let mode = 0o666;
  try { mode = (await nodeStat(uri.fsPath)).mode & 0o777; }
  catch { /* A new Save As target uses the process umask. */ }
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, uri.fsPath);
    // Persist the directory entry where the platform permits directory fsync.
    try {
      const directory = await open(dirname(uri.fsPath), 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch { /* Unsupported on some virtualized/Windows file systems. */ }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function safeFallbackPreview(uri: vscode.Uri, size: number): Promise<string> {
  if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') return 'Raw preview is unavailable for this virtual file system.';
  try {
    const handle = await open(uri.fsPath, 'r');
    try {
      const headSize = Math.min(size, 128 * 1024);
      const tailSize = size > headSize ? Math.min(64 * 1024, size - headSize) : 0;
      const head = Buffer.alloc(headSize);
      const tail = Buffer.alloc(tailSize);
      await handle.read(head, 0, head.length, 0);
      if (tail.length > 0) await handle.read(tail, 0, tail.length, size - tail.length);
      const decoder = new TextDecoder('utf-8');
      return tail.length > 0
        ? `${decoder.decode(head)}\n\n… ${size - head.length - tail.length} bytes omitted …\n\n${decoder.decode(tail)}`
        : decoder.decode(head);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return `Unable to create the truncated preview: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export class ViewerDocument implements vscode.CustomDocument {
  readonly sessionId = randomUUID();
  readonly settings = readSettings();
  private client: WorkerClient | undefined;
  private bootstrapValue!: DocumentBootstrap;
  private text: string | undefined;
  private savedText: string | undefined;
  private dirty = false;
  private disposed = false;
  private suppressWatcher = false;
  private pendingIndexReady: IndexReadyEvent | undefined;
  private watcher?: vscode.FileSystemWatcher;
  private lastKnownMtime = 0;
  private lastKnownSize = 0;
  private sourceInvalidated = false;
  private loadGeneration = 0;
  private mutation = Promise.resolve();

  private readonly editEmitter = new vscode.EventEmitter<ViewerDocumentEdit>();
  private readonly bootstrapEmitter = new vscode.EventEmitter<DocumentBootstrap>();
  private readonly stateEmitter = new vscode.EventEmitter<boolean>();
  private readonly workerEventEmitter = new vscode.EventEmitter<WorkerEvent>();
  private readonly externalChangeEmitter = new vscode.EventEmitter<string>();
  private readonly crashEmitter = new vscode.EventEmitter<string>();

  readonly onDidEdit = this.editEmitter.event;
  readonly onDidChangeBootstrap = this.bootstrapEmitter.event;
  readonly onDidChangeState = this.stateEmitter.event;
  readonly onDidReceiveWorkerEvent = this.workerEventEmitter.event;
  readonly onDidDetectExternalChange = this.externalChangeEmitter.event;
  readonly onDidCrash = this.crashEmitter.event;

  private constructor(
    readonly uri: vscode.Uri,
    readonly kind: DocumentKind,
    private readonly extensionUri: vscode.Uri,
    private readonly cacheDirectory: string,
  ) {}

  static async open(
    uri: vscode.Uri,
    kind: DocumentKind,
    extensionUri: vscode.Uri,
    cacheDirectory: string,
    backupId: string | undefined,
    token: vscode.CancellationToken,
  ): Promise<ViewerDocument> {
    const document = new ViewerDocument(uri, kind, extensionUri, cacheDirectory);
    try {
      await document.load(backupId ? vscode.Uri.parse(backupId) : undefined, token);
      document.startWatcher();
      return document;
    } catch (error) {
      document.dispose();
      throw error;
    }
  }

  get bootstrap(): DocumentBootstrap { return this.bootstrapValue; }
  get isDirty(): boolean { return this.dirty; }
  get isEditable(): boolean { return this.bootstrapValue.editable; }

  private createClient(): WorkerClient {
    this.client?.dispose();
    const client = new WorkerClient(this.extensionUri);
    client.onDidReceiveEvent((event) => {
      if (event.event === 'indexReady') {
        this.pendingIndexReady = event;
        if (this.bootstrapValue) this.applyIndexReady(event);
      }
      this.workerEventEmitter.fire(event);
    });
    client.onDidCrash((message) => this.crashEmitter.fire(`${message} The current preview was isolated; use Refresh to restart it.`));
    this.client = client;
    return client;
  }

  /**
   * Large JSON is deliberately opened in two phases.  Returning the custom
   * document after the file metadata is known lets VS Code paint the webview
   * immediately, while the isolated worker builds the structured tree.  This
   * mirrors JSONL's fast first-page path and prevents a long parse from making
   * the editor window appear frozen.
   */
  private startDeferredJsonOpen(source: WorkerSource, cacheKey: string, fileSize: number): void {
    const generation = this.loadGeneration;
    const client = this.createClient();
    void client.request({
      type: 'session/open',
      sessionId: this.sessionId,
      kind: 'json',
      source,
      settings: this.settings,
      cacheDirectory: this.cacheDirectory,
      cacheKey,
    }).then((response) => {
      if (this.disposed || generation !== this.loadGeneration || this.client !== client) {
        if (this.client !== client) client.dispose();
        return;
      }
      this.setBootstrapResult(response as SessionOpenResult);
    }).catch(async (error: unknown) => {
      if (this.disposed || generation !== this.loadGeneration || this.client !== client) return;
      client.dispose();
      this.client = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      const preview = await safeFallbackPreview(this.uri, fileSize);
      if (this.disposed || generation !== this.loadGeneration) return;
      const { openResult: _old, ...base } = this.bootstrapValue;
      this.bootstrapValue = {
        ...base,
        mode: 'fallback',
        editable: false,
        fallbackReason: reason,
        fallbackPreview: preview,
      };
      this.bootstrapEmitter.fire(this.bootstrapValue);
    });
  }

  private async load(backupUri: vscode.Uri | undefined, token: vscode.CancellationToken): Promise<void> {
    this.loadGeneration++;
    const sourceUri = backupUri ?? this.uri;
    const fileStat = await vscode.workspace.fs.stat(sourceUri);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const fileSize = fileStat.size;
    this.dirty = backupUri !== undefined;
    if (backupUri) {
      try {
        const original = await vscode.workspace.fs.stat(this.uri);
        this.lastKnownMtime = original.mtime;
        this.lastKnownSize = original.size;
      } catch {
        this.lastKnownMtime = 0;
        this.lastKnownSize = 0;
      }
    } else {
      this.lastKnownMtime = fileStat.mtime;
      this.lastKnownSize = fileSize;
    }
    this.sourceInvalidated = false;
    const editableLimit = this.kind === 'jsonl' ? Math.min(this.settings.editableMaxBytes, 10 * 1024 * 1024) : this.settings.editableMaxBytes;
    let mode: DocumentMode = fileSize <= editableLimit && (this.kind !== 'json' || fileSize <= this.settings.maxJsonBytes)
      ? 'editable'
      : 'readonly';
    let fallbackReason: string | undefined;
    let fallbackPreview: string | undefined;
    if (this.kind === 'json' && fileSize > this.settings.maxJsonBytes) {
      mode = 'fallback';
      fallbackReason = `This JSON file is larger than the configured ${Math.round(this.settings.maxJsonBytes / 1024 / 1024)} MB complete-tree limit.`;
    }

    let workerSource: WorkerSource | undefined;
    const nativeWorkerSource = async (): Promise<WorkerSource> => {
      const details = await nodeStat(sourceUri.fsPath);
      if (details.size !== fileSize) throw new Error('Filesystem size does not match the workspace file provider.');
      const signature: SourceSignature = { size: details.size, mtimeMs: details.mtimeMs, dev: details.dev, ino: details.ino };
      return { type: 'file', path: sourceUri.fsPath, signature };
    };
    if (mode === 'editable') {
      const bytes = await vscode.workspace.fs.readFile(sourceUri);
      if (!backupUri) {
        const afterRead = await vscode.workspace.fs.stat(sourceUri);
        if (afterRead.size !== fileSize || afterRead.mtime !== fileStat.mtime) {
          throw new WorkerClientError('SOURCE_CHANGED', 'The source file changed while it was being opened. Open it again to use the latest contents.');
        }
      }
      try {
        this.text = strictUtf8(bytes);
        this.savedText = backupUri ? undefined : this.text;
        workerSource = { type: 'text', text: this.text };
      } catch (error) {
        if (this.kind === 'jsonl' && !backupUri) {
          // Keep invalid UTF-8 bytes intact so the JSONL scanner can mark only
          // the affected record instead of rejecting the entire document.
          try {
            mode = 'readonly';
            workerSource = await nativeWorkerSource();
          } catch (nativeError) {
            mode = 'fallback';
            fallbackReason = nativeError instanceof Error ? nativeError.message : String(nativeError);
          }
        } else {
          mode = 'fallback';
          fallbackReason = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (mode === 'readonly' && !workerSource) {
      try {
        workerSource = await nativeWorkerSource();
      } catch (error) {
        mode = 'fallback';
        fallbackReason = `Large-file streaming is unavailable for this file system: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const cacheKey = createHash('sha256').update(`${this.uri.toString()}\0${fileSize}\0${fileStat.mtime}`).digest('hex');

    // A read-only JSON file can be parsed without blocking custom-editor
    // resolution.  Keep editable/small JSON synchronous because those files
    // need their source text for edits and hot-exit backups.
    if (this.kind === 'json' && mode === 'readonly' && workerSource?.type === 'file') {
      this.bootstrapValue = {
        sessionId: this.sessionId,
        uri: this.uri.toString(),
        name: basename(this.uri.path) || this.uri.toString(),
        kind: this.kind,
        mode,
        editable: false,
        fileSize,
        settings: this.settings,
      };
      this.startDeferredJsonOpen(workerSource, cacheKey, fileSize);
      return;
    }

    let openResult: SessionOpenResult | undefined;
    if (mode !== 'fallback' && workerSource) {
      const client = this.createClient();
      try {
        const response = await client.request({
          type: 'session/open',
          sessionId: this.sessionId,
          kind: this.kind,
          source: workerSource,
          settings: this.settings,
          cacheDirectory: this.cacheDirectory,
          cacheKey,
        });
        openResult = response as SessionOpenResult;
        if (openResult.kind === 'jsonl' && this.pendingIndexReady) {
          openResult = {
            ...openResult,
            fields: this.pendingIndexReady.fields,
            indexReady: true,
            recordCount: this.pendingIndexReady.recordCount,
            indexMilliseconds: this.pendingIndexReady.indexMilliseconds,
          };
        }
      } catch (error) {
        client.dispose();
        this.client = undefined;
        mode = 'fallback';
        fallbackReason = error instanceof Error ? error.message : String(error);
      }
    }
    if (mode === 'fallback') {
      fallbackPreview = this.text !== undefined
        ? this.text.slice(0, 192 * 1024) + (this.text.length > 192 * 1024 ? '\n… preview truncated …' : '')
        : await safeFallbackPreview(this.uri, fileSize);
    }

    this.bootstrapValue = {
      sessionId: this.sessionId,
      uri: this.uri.toString(),
      name: basename(this.uri.path) || this.uri.toString(),
      kind: openResult?.kind ?? this.kind,
      mode,
      editable: mode === 'editable',
      fileSize,
      settings: this.settings,
      ...(fallbackPreview !== undefined ? { fallbackPreview } : {}),
      ...(fallbackReason !== undefined ? { fallbackReason } : {}),
      ...(openResult !== undefined ? { openResult } : {}),
      ...(this.dirty ? { dirty: true } : {}),
    };
  }

  private invalidateSource(message: string): void {
    if (this.disposed || this.sourceInvalidated) return;
    this.sourceInvalidated = true;
    this.client?.dispose();
    this.client = undefined;
    this.externalChangeEmitter.fire(message);
  }

  private startWatcher(): void {
    if (this.uri.scheme !== 'file') return;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirname(this.uri.fsPath), basename(this.uri.fsPath)));
    const changed = async (): Promise<void> => {
      if (this.disposed || this.suppressWatcher) return;
      try {
        const details = await vscode.workspace.fs.stat(this.uri);
        if (details.mtime === this.lastKnownMtime && details.size === this.lastKnownSize) return;
        this.invalidateSource('The file changed on disk. Refresh the viewer to use the new contents.');
      } catch {
        this.invalidateSource('The source file was deleted or became unavailable.');
      }
    };
    this.watcher.onDidChange(() => void changed());
    this.watcher.onDidDelete(() => void changed());
  }

  private setBootstrapResult(result: SessionOpenResult): void {
    this.updateBootstrapResult(result);
    this.bootstrapEmitter.fire(this.bootstrapValue);
  }

  private updateBootstrapResult(result: SessionOpenResult): void {
    const { openResult: _old, dirty: _dirty, ...base } = this.bootstrapValue;
    this.bootstrapValue = { ...base, kind: result.kind, openResult: result, ...(this.dirty ? { dirty: true } : {}) };
  }

  private applyIndexReady(event: IndexReadyEvent): void {
    if (!this.bootstrapValue?.openResult || this.bootstrapValue.openResult.kind !== 'jsonl') return;
    const result: SessionOpenResult = {
      ...this.bootstrapValue.openResult,
      fields: event.fields,
      indexReady: true,
      recordCount: event.recordCount,
      indexMilliseconds: event.indexMilliseconds,
    };
    const { openResult: _old, ...base } = this.bootstrapValue;
    // Existing panels receive the worker event directly and keep their local
    // table/query state. Persist the result silently for panels resolved later.
    this.bootstrapValue = { ...base, openResult: result };
  }

  private async reloadWorkerText(updated: string): Promise<SessionOpenResult> {
    if (!this.client) throw new WorkerClientError('WORKER_UNAVAILABLE', 'This preview is not editable.');
    const response = await this.client.request({ type: 'session/reloadText', sessionId: this.sessionId, text: updated });
    if (!('reloaded' in response)) throw new WorkerClientError('INVALID_RESPONSE', 'The worker returned an unexpected edit response.');
    return response.result;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.mutation.then(operation, operation);
    this.mutation = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async applyEdit(edit: ViewerEdit): Promise<ViewerEditResult> {
    return this.enqueue(async () => {
      if (!this.bootstrapValue.editable || this.text === undefined) throw new WorkerClientError('READ_ONLY', 'Files above the edit limit are read-only.');
      const before = this.text;
      if (!this.client) throw new WorkerClientError('WORKER_UNAVAILABLE', 'The preview worker is unavailable. Refresh the editor.');
      const response = await this.client.request({ type: 'session/applyEdit', sessionId: this.sessionId, edit });
      if (!('edited' in response)) throw new WorkerClientError('INVALID_RESPONSE', 'The worker returned an unexpected edit response.');
      const after = response.text;
      if (after === before) return { applied: true, dirty: this.dirty };
      const result = response.result;
      this.text = after;
      this.dirty = after !== this.savedText;
      this.updateBootstrapResult(result);
      let row;
      if (result.kind === 'jsonl' && edit.physicalLine !== undefined) {
        row = result.initialRows.find((candidate) => candidate.physicalLine === edit.physicalLine);
        if (!row) {
          const page = await this.client.request({
            type: 'jsonl/page', sessionId: this.sessionId, queryId: 'default',
            offset: edit.physicalLine - 1, limit: 1,
          });
          if ('rows' in page) row = page.rows[0];
        }
      }
      this.stateEmitter.fire(this.dirty);
      const delta = makeDelta(before, after);
      const label = edit.kind === 'delete' ? 'Delete JSON node' : edit.kind === 'rename' ? 'Rename JSON property' : edit.kind === 'add' ? 'Add JSON node' : 'Edit JSON value';
      this.editEmitter.fire({
        label,
        undo: () => this.enqueue(() => this.applyHistoryDelta(delta, true)),
        redo: () => this.enqueue(() => this.applyHistoryDelta(delta, false)),
      });
      return { applied: true, dirty: this.dirty, ...(row ? { row } : {}) };
    });
  }

  private async applyHistoryDelta(delta: TextDelta, reverse: boolean): Promise<void> {
    if (this.text === undefined) return;
    const updated = applyDelta(this.text, delta, reverse);
    const result = await this.reloadWorkerText(updated);
    this.text = updated;
    this.dirty = updated !== this.savedText;
    this.setBootstrapResult(result);
  }

  async workerRequest(action: ViewerAction, requestId: string): Promise<WorkerResponseData | ViewerEditResult> {
    if (action.type === 'edit') {
      return this.applyEdit(action.edit);
    }
    if (action.type === 'cancel') {
      await this.client?.cancel(action.targetRequestId);
      return { cancelled: true };
    }
    const client = this.client;
    if (!client) throw new WorkerClientError('FALLBACK_MODE', 'Structured operations are unavailable in the safe fallback preview.');
    try {
      switch (action.type) {
        case 'json/children':
          return await client.request({ type: 'json/children', sessionId: this.sessionId, pointer: action.pointer, offset: action.offset, limit: action.limit }, { requestId });
        case 'json/childPage':
          return await client.request({ type: 'json/childPage', sessionId: this.sessionId, parentPointer: action.parentPointer, childPointer: action.childPointer, limit: action.limit }, { requestId });
        case 'json/search':
          return await client.request({ type: 'json/search', sessionId: this.sessionId, query: action.query, limit: action.limit }, { requestId });
        case 'jsonl/page':
          return await client.request({ type: 'jsonl/page', sessionId: this.sessionId, queryId: action.queryId, offset: action.offset, limit: action.limit }, { requestId });
        case 'jsonl/query':
          return await client.request({ type: 'jsonl/query', sessionId: this.sessionId, queryId: action.queryId, spec: action.spec }, { requestId });
        case 'jsonl/treeChildren':
          return await client.request({ type: 'jsonl/treeChildren', sessionId: this.sessionId, physicalLine: action.physicalLine, pointer: action.pointer, offset: action.offset, limit: action.limit }, { requestId });
        case 'jsonl/valueChunk':
          return await client.request({ type: 'jsonl/valueChunk', sessionId: this.sessionId, physicalLine: action.physicalLine, pointer: action.pointer, offset: action.offset, limit: action.limit }, { requestId });
        default:
          throw new WorkerClientError('INVALID_ACTION', 'This action is handled by the editor host.');
      }
    } catch (error) {
      if (error instanceof WorkerClientError && error.code === 'SOURCE_CHANGED') {
        if (this.client === client) this.invalidateSource('The file changed on disk. Refresh the viewer to use the new contents.');
        else client.dispose();
      }
      throw error;
    }
  }

  async refresh(token: vscode.CancellationToken = new vscode.CancellationTokenSource().token): Promise<void> {
    await this.enqueue(async () => {
      this.client?.dispose();
      this.client = undefined;
      this.text = undefined;
      this.savedText = undefined;
      this.dirty = false;
      this.pendingIndexReady = undefined;
      await this.load(undefined, token);
      this.bootstrapEmitter.fire(this.bootstrapValue);
    });
  }

  async save(destination: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
    await this.enqueue(async () => {
      if (!this.bootstrapValue.editable || this.text === undefined) return;
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const savesOriginal = destination.toString() === this.uri.toString();
      if (savesOriginal && this.sourceInvalidated) {
        throw new WorkerClientError('SOURCE_CHANGED', 'The file changed on disk. Refresh it before saving to avoid overwriting external changes.');
      }
      if (savesOriginal && (this.lastKnownMtime !== 0 || this.lastKnownSize !== 0)) {
        try {
          const current = await vscode.workspace.fs.stat(this.uri);
          if (current.mtime !== this.lastKnownMtime || current.size !== this.lastKnownSize) {
            this.invalidateSource('The file changed on disk. Refresh the viewer before saving.');
            throw new WorkerClientError('SOURCE_CHANGED', 'The file changed on disk. Refresh it before saving to avoid overwriting external changes.');
          }
        } catch (error) {
          if (error instanceof WorkerClientError) throw error;
          this.invalidateSource('The source file was deleted or became unavailable.');
          throw new WorkerClientError('SOURCE_CHANGED', 'The source file is no longer available. Use Save As to preserve your edits.');
        }
      }
      this.suppressWatcher = true;
      try {
        await atomicWrite(destination, new TextEncoder().encode(this.text));
        if (savesOriginal) {
          const details = await vscode.workspace.fs.stat(this.uri);
          this.lastKnownMtime = details.mtime;
          this.lastKnownSize = details.size;
          this.sourceInvalidated = false;
        }
        this.savedText = this.text;
        this.dirty = false;
        this.updateBootstrapResult(this.bootstrapValue.openResult!);
        this.stateEmitter.fire(false);
      } finally {
        this.suppressWatcher = false;
      }
    });
  }

  async revert(token: vscode.CancellationToken): Promise<void> {
    await this.refresh(token);
  }

  async backup(destination: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (this.text === undefined) throw new WorkerClientError('READ_ONLY', 'Read-only previews do not require a hot-exit backup.');
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(this.text));
    return {
      id: destination.toString(),
      delete: async () => vscode.workspace.fs.delete(destination).then(() => undefined, () => undefined),
    };
  }

  async revealSource(path: JsonPath, physicalLine?: number): Promise<void> {
    let sourceOffset: number | undefined;
    if (!physicalLine && this.client) {
      try {
        const response = await this.client.request({ type: 'json/location', sessionId: this.sessionId, pointer: pointerFromPath(path) });
        if ('offset' in response) sourceOffset = response.offset;
      } catch (error) {
        if (error instanceof WorkerClientError && error.code === 'SOURCE_CHANGED') {
          this.invalidateSource('The file changed on disk. Refresh the viewer to use the new contents.');
        }
        // Large/fallback JSON still opens as text, without an exact offset.
      }
    }
    const textDocument = await vscode.workspace.openTextDocument(this.uri);
    const editor = await vscode.window.showTextDocument(textDocument, { preview: false });
    if (physicalLine) {
      const position = new vscode.Position(Math.max(0, physicalLine - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    if (sourceOffset === undefined) return;
    const position = textDocument.positionAt(sourceOffset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const client = this.client;
    this.client = undefined;
    if (client) {
      // Capture the worker being closed. A refresh can create a replacement
      // client before this close request settles; disposing through
      // `this.client` here would then terminate the replacement worker.
      void client.request({ type: 'session/close', sessionId: this.sessionId }).finally(() => client.dispose());
    }
    this.watcher?.dispose();
    this.editEmitter.dispose();
    this.bootstrapEmitter.dispose();
    this.stateEmitter.dispose();
    this.workerEventEmitter.dispose();
    this.externalChangeEmitter.dispose();
    this.crashEmitter.dispose();
  }
}
