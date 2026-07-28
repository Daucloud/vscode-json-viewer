import type { HostToWebviewMessage, ViewerAction, ViewerEditResult, WebviewToHostMessage } from '../shared/webviewProtocol.js';
import type { DocumentBootstrap, WorkerEvent, WorkerFailure } from '../shared/types.js';
import type { WorkerResponseData } from '../worker/protocol.js';

interface VsCodeApi<State> {
  postMessage(message: WebviewToHostMessage): void;
  getState(): State | undefined;
  setState(state: State): void;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

export interface PersistedState {
  expandedJson?: string[];
  expandedRow?: string[];
  selectedPointer?: string;
  selectedPhysicalLine?: number;
  columnWidths?: Record<string, number>;
  queryText?: string;
  filterPointer?: string;
  filterOperation?: string;
  filterValue?: string;
  sortPointer?: string;
  sortDirection?: 'asc' | 'desc';
  jsonScrollTop?: number;
  tableScrollTop?: number;
  jsonlTablePanePercent?: number;
  treePanePercent?: number;
  jsonlDetailMaximized?: boolean;
}

export type NotificationKind = 'external' | 'crash' | 'error';

export class RequestError extends Error {
  constructor(readonly failure: WorkerFailure) {
    super(failure.message);
    this.name = 'RequestError';
  }
}

type ResponseData = WorkerResponseData | ViewerEditResult | { acknowledged: true };

class WebviewApi {
  private readonly vscode = acquireVsCodeApi<PersistedState>();
  private currentState: PersistedState = this.vscode.getState() ?? {};
  private stateTimer: number | undefined;
  private readonly pending = new Map<string, { resolve: (data: ResponseData) => void; reject: (error: RequestError) => void }>();
  private readonly bootstrapListeners = new Set<(bootstrap: DocumentBootstrap) => void>();
  private readonly documentStateListeners = new Set<(dirty: boolean) => void>();
  private readonly eventListeners = new Set<(event: WorkerEvent) => void>();
  private readonly notificationListeners = new Set<(message: string, kind: NotificationKind) => void>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => this.receive(event.data));
    window.addEventListener('pagehide', () => this.flushState());
  }

  ready(): void { this.vscode.postMessage({ type: 'ready' }); }

  request<T extends ResponseData = ResponseData>(action: ViewerAction, requestId = crypto.randomUUID()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
      });
      try {
        this.vscode.postMessage({ type: 'request', requestId, action });
      } catch (caught) {
        this.pending.delete(requestId);
        reject(new RequestError({ code: 'WEBVIEW_UNAVAILABLE', message: caught instanceof Error ? caught.message : String(caught) }));
      }
    });
  }

  command(action: ViewerAction): void {
    void this.request(action).catch((caught: unknown) => {
      if (caught instanceof RequestError && (caught.failure.code === 'CANCELLED' || /cancel/i.test(caught.failure.message))) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      for (const listener of this.notificationListeners) listener(message, 'error');
    });
  }

  requestWithId<T extends ResponseData = ResponseData>(action: ViewerAction): { requestId: string; promise: Promise<T> } {
    const requestId = crypto.randomUUID();
    return { requestId, promise: this.request<T>(action, requestId) };
  }

  onBootstrap(listener: (bootstrap: DocumentBootstrap) => void): () => void {
    this.bootstrapListeners.add(listener);
    return () => this.bootstrapListeners.delete(listener);
  }

  onWorkerEvent(listener: (event: WorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDocumentState(listener: (dirty: boolean) => void): () => void {
    this.documentStateListeners.add(listener);
    return () => this.documentStateListeners.delete(listener);
  }

  onNotification(listener: (message: string, kind: NotificationKind) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  state(): PersistedState { return this.currentState; }

  updateState(update: Partial<PersistedState>): void {
    this.currentState = { ...this.currentState, ...update };
    if (this.stateTimer !== undefined) window.clearTimeout(this.stateTimer);
    this.stateTimer = window.setTimeout(() => this.flushState(), 100);
  }

  private flushState(): void {
    if (this.stateTimer !== undefined) window.clearTimeout(this.stateTimer);
    this.vscode.setState(this.currentState);
    this.stateTimer = undefined;
  }

  private receive(message: HostToWebviewMessage): void {
    if (message.type === 'bootstrap') {
      for (const listener of this.bootstrapListeners) listener(message.data);
      return;
    }
    if (message.type === 'workerEvent') {
      for (const listener of this.eventListeners) listener(message.data);
      return;
    }
    if (message.type === 'documentState') {
      for (const listener of this.documentStateListeners) listener(message.dirty);
      return;
    }
    if (message.type === 'externalChange' || message.type === 'workerCrash') {
      for (const listener of this.notificationListeners) listener(message.message, message.type === 'externalChange' ? 'external' : 'crash');
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new RequestError(message.error));
  }
}

export const api = new WebviewApi();
