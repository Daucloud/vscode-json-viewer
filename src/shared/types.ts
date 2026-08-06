export type DocumentKind = 'json' | 'jsonl';
export type DocumentMode = 'editable' | 'readonly' | 'fallback';
export type JsonValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
export type JsonPath = Array<string | number>;

export type JsonEditOperation =
  | { kind: 'set'; path: JsonPath; value: unknown; physicalLine?: number }
  | { kind: 'setRaw'; path: JsonPath; raw: string; physicalLine?: number }
  | { kind: 'delete'; path: JsonPath; physicalLine?: number }
  | { kind: 'add'; path: JsonPath; value: unknown; insertArray?: boolean; physicalLine?: number }
  | { kind: 'rename'; path: JsonPath; newKey: string; physicalLine?: number };

export interface PreviewSettings {
  editableMaxBytes: number;
  maxJsonBytes: number;
  pageSize: number;
  schemaSampleRows: number;
  maxLineBytes: number;
  sortMaxRows: number;
  indexCacheBytes: number;
}

export interface SourceSignature {
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
  edgeHash?: string;
}

export interface TreeNodeSummary {
  pointer: string;
  key: string;
  type: JsonValueType;
  preview: string;
  raw?: string;
  childCount: number;
  hasChildren: boolean;
}

export interface TreeChildrenResult {
  parentPointer: string;
  parent?: TreeNodeSummary;
  offset: number;
  total: number;
  children: TreeNodeSummary[];
}

export interface TreeSearchMatch {
  pointer: string;
  key: string;
  type: JsonValueType;
  preview: string;
}

export interface TreeSearchResult {
  matches: TreeSearchMatch[];
  truncated: boolean;
  visited: number;
}

export interface JsonSourceLocation {
  offset: number;
}

export type JsonlRowStatus = 'valid' | 'invalid' | 'tooLarge' | 'empty';
export type JsonlCell = string | number | boolean | null;

export interface JsonlDiagnostic {
  code: 'INVALID_JSON' | 'LINE_TOO_LARGE' | 'EMPTY_LINE' | 'INVALID_UTF8';
  message: string;
  column: number;
}

export interface JsonlRow {
  resultIndex: number;
  physicalLine: number;
  status: JsonlRowStatus;
  cells: Record<string, JsonlCell>;
  raw: string;
  rawTruncated?: boolean;
  diagnostic?: JsonlDiagnostic;
}

export interface JsonlPageResult {
  queryId: string;
  offset: number;
  total: number;
  rows: JsonlRow[];
}

export interface JsonlValueChunkResult {
  physicalLine: number;
  pointer: string;
  offset: number;
  nextOffset: number;
  totalChars: number;
  chunk: string;
  done: boolean;
  completeAvailable: boolean;
}

export type FilterLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null };

export type StructuredFilter =
  | { op: 'compare'; pointer: string; comparator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; value: FilterLiteral }
  | { op: 'contains'; pointer: string; value: string; caseSensitive: boolean }
  | { op: 'exists'; pointer: string }
  | { op: 'isNull'; pointer: string };

export interface JsonlQuerySpec {
  text?: string;
  caseSensitive?: boolean;
  filter?: StructuredFilter;
  sort?: {
    pointer: string;
    direction: 'asc' | 'desc';
  };
}

export interface JsonlQueryResult {
  queryId: string;
  scannedRows: number;
  matchedRows: number;
  elapsedMs: number;
}

export interface JsonOpenResult {
  kind: 'json';
  root: TreeNodeSummary;
  parseMilliseconds: number;
}

export interface JsonlOpenResult {
  kind: 'jsonl';
  fields: string[];
  initialRows: JsonlRow[];
  indexReady: boolean;
  recordCount?: number;
  indexMilliseconds?: number;
}

export type SessionOpenResult = JsonOpenResult | JsonlOpenResult;

export interface DocumentBootstrap {
  sessionId: string;
  uri: string;
  name: string;
  kind: DocumentKind;
  mode: DocumentMode;
  editable: boolean;
  fileSize: number;
  settings: PreviewSettings;
  fallbackPreview?: string;
  fallbackReason?: string;
  openResult?: SessionOpenResult;
  dirty?: boolean;
}

export interface QueryProgressEvent {
  event: 'progress';
  sessionId: string;
  task: 'index' | 'query' | 'search';
  requestId?: string;
  scannedBytes: number;
  totalBytes: number;
  records: number;
  matches?: number;
}

export interface IndexReadyEvent {
  event: 'indexReady';
  sessionId: string;
  recordCount: number;
  fields: string[];
  indexMilliseconds: number;
}

export interface WorkerWarningEvent {
  event: 'warning';
  sessionId: string;
  code: string;
  message: string;
}

export type WorkerEvent = QueryProgressEvent | IndexReadyEvent | WorkerWarningEvent;

export interface WorkerFailure {
  code: string;
  message: string;
  stack?: string;
}
