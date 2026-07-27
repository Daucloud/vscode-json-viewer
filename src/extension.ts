import * as vscode from 'vscode';
import { readSettings } from './configuration.js';
import { ViewerEditorProvider } from './editorProvider.js';
import { ViewerDocument } from './viewerDocument.js';
import { WorkerClient } from './workerClient.js';

const JSON_VIEW_TYPE = 'fastJsonViewer.json';
const JSONL_VIEW_TYPE = 'fastJsonViewer.jsonl';

function kindForUri(uri: vscode.Uri): 'json' | 'jsonl' {
  return /\.(?:jsonl|ndjson|jsonlines)$/i.test(uri.path) ? 'jsonl' : 'json';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function activate(context: vscode.ExtensionContext): void {
  let activeDocument: ViewerDocument | undefined;
  let activePanel: vscode.WebviewPanel | undefined;
  const setActive = (panel: vscode.WebviewPanel, document?: ViewerDocument): void => {
    if (document) {
      activePanel = panel;
      activeDocument = document;
    } else if (activePanel === panel) {
      activePanel = undefined;
      activeDocument = undefined;
    }
  };

  const jsonProvider = new ViewerEditorProvider(context, 'json', setActive);
  const jsonlProvider = new ViewerEditorProvider(context, 'jsonl', setActive);
  context.subscriptions.push(
    jsonProvider,
    jsonlProvider,
    vscode.window.registerCustomEditorProvider(JSON_VIEW_TYPE, jsonProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(JSONL_VIEW_TYPE, jsonlProvider, {
      webviewOptions: { retainContextWhenHidden: false },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  context.subscriptions.push(vscode.commands.registerCommand('fastJsonViewer.open', async (resource?: vscode.Uri) => {
    const uri = resource ?? activeDocument?.uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage('Select a JSON, JSONL, or NDJSON file first.');
      return;
    }
    const viewType = kindForUri(uri) === 'jsonl' ? JSONL_VIEW_TYPE : JSON_VIEW_TYPE;
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastJsonViewer.refresh', async () => {
    if (!activeDocument) return;
    if (activeDocument.isDirty) {
      const choice = await vscode.window.showWarningMessage('Refresh will discard unsaved viewer edits.', { modal: true }, 'Discard and Refresh');
      if (choice !== 'Discard and Refresh') return;
    }
    await activeDocument.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastJsonViewer.openAsText', async (resource?: vscode.Uri) => {
    const uri = resource ?? activeDocument?.uri;
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('fastJsonViewer.clearIndexCache', async () => {
    const cacheDirectory = vscode.Uri.joinPath(context.globalStorageUri, 'indexes').fsPath;
    const worker = new WorkerClient(context.extensionUri);
    try {
      const response = await worker.request({ type: 'cache/prune', cacheDirectory, maxBytes: 0 });
      const removedBytes = 'removedBytes' in response ? response.removedBytes : 0;
      void vscode.window.showInformationMessage(`Fast JSON Viewer cache cleared (${formatBytes(removedBytes)} removed). Refresh open JSONL viewers if needed.`);
    } finally {
      worker.dispose();
    }
  }));

  // Prune old indexes in the background without delaying extension activation.
  const cacheWorker = new WorkerClient(context.extensionUri);
  void cacheWorker.request({
    type: 'cache/prune',
    cacheDirectory: vscode.Uri.joinPath(context.globalStorageUri, 'indexes').fsPath,
    maxBytes: readSettings().indexCacheBytes,
  }).catch(() => undefined).finally(() => cacheWorker.dispose());
}

export function deactivate(): void {}
