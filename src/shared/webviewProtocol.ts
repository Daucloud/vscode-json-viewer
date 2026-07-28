import type {
  DocumentBootstrap,
  JsonEditOperation,
  JsonPath,
  JsonlRow,
  JsonlQuerySpec,
  WorkerEvent,
  WorkerFailure,
} from './types.js';
import type { WorkerResponseData } from '../worker/protocol.js';

export type ViewerEdit = JsonEditOperation;

export interface ViewerEditResult {
  applied: true;
  dirty: boolean;
  row?: JsonlRow;
}

export type ViewerAction =
  | { type: 'json/children'; pointer: string; offset: number; limit: number }
  | { type: 'json/childPage'; parentPointer: string; childPointer: string; limit: number }
  | { type: 'json/search'; query: string; limit: number }
  | { type: 'jsonl/page'; queryId: string; offset: number; limit: number }
  | { type: 'jsonl/query'; queryId: string; spec: JsonlQuerySpec }
  | { type: 'jsonl/treeChildren'; physicalLine: number; pointer: string; offset: number; limit: number }
  | { type: 'edit'; edit: ViewerEdit }
  | { type: 'cancel'; targetRequestId: string }
  | { type: 'copy'; text: string }
  | { type: 'openAsText'; physicalLine?: number; column?: number }
  | { type: 'revealSource'; path: JsonPath; physicalLine?: number }
  | { type: 'refresh' }
  | { type: 'save' }
  | { type: 'saveAs' }
  | { type: 'undo' }
  | { type: 'redo' };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'request'; requestId: string; action: ViewerAction };

export type HostToWebviewMessage =
  | { type: 'bootstrap'; data: DocumentBootstrap }
  | { type: 'documentState'; dirty: boolean }
  | { type: 'response'; requestId: string; ok: true; data: WorkerResponseData | ViewerEditResult | { acknowledged: true } }
  | { type: 'response'; requestId: string; ok: false; error: WorkerFailure }
  | { type: 'workerEvent'; data: WorkerEvent }
  | { type: 'externalChange'; message: string }
  | { type: 'workerCrash'; message: string };
