import * as vscode from 'vscode';
import type { HostToWebviewMessage, ViewerAction, WebviewToHostMessage } from './shared/webviewProtocol.js';
import { ViewerDocument } from './viewerDocument.js';
import { webviewHtml } from './webviewHtml.js';
import { workerFailure } from './workerClient.js';
import type { DocumentKind } from './shared/types.js';

function post(panel: vscode.WebviewPanel, message: HostToWebviewMessage): void {
  void panel.webview.postMessage(message);
}

export class ViewerEditorProvider implements vscode.CustomEditorProvider<ViewerDocument>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ViewerDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly kind: DocumentKind,
    private readonly setActive: (panel: vscode.WebviewPanel, document?: ViewerDocument) => void,
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken,
  ): Promise<ViewerDocument> {
    const cacheDirectory = vscode.Uri.joinPath(this.context.globalStorageUri, 'indexes').fsPath;
    const document = await ViewerDocument.open(uri, this.kind, this.context.extensionUri, cacheDirectory, openContext.backupId, token);
    document.onDidEdit((edit) => {
      this.changeEmitter.fire({ document, label: edit.label, undo: edit.undo, redo: edit.redo });
    });
    return document;
  }

  async resolveCustomEditor(
    document: ViewerDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
    if (panel.active) this.setActive(panel, document);

    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.setActive(panel, document);
      else this.setActive(panel);
    }));
    subscriptions.push(document.onDidChangeBootstrap((bootstrap) => post(panel, { type: 'bootstrap', data: bootstrap })));
    subscriptions.push(document.onDidReceiveWorkerEvent((event) => post(panel, { type: 'workerEvent', data: event })));
    subscriptions.push(document.onDidDetectExternalChange((message) => post(panel, { type: 'externalChange', message })));
    subscriptions.push(document.onDidCrash((message) => post(panel, { type: 'workerCrash', message })));
    subscriptions.push(panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      void this.handleMessage(document, panel, message);
    }));
    panel.onDidDispose(() => {
      for (const subscription of subscriptions) subscription.dispose();
      // WebviewPanel.active throws after disposal in recent VS Code builds.
      // The next active panel will immediately replace this registry entry.
      this.setActive(panel);
    });
  }

  private async handleMessage(document: ViewerDocument, panel: vscode.WebviewPanel, message: WebviewToHostMessage): Promise<void> {
    if (message.type === 'ready') {
      post(panel, { type: 'bootstrap', data: document.bootstrap });
      return;
    }
    if (message.type !== 'request') return;
    try {
      const data = await this.handleAction(document, message.action, message.requestId);
      post(panel, { type: 'response', requestId: message.requestId, ok: true, data });
    } catch (error) {
      post(panel, { type: 'response', requestId: message.requestId, ok: false, error: workerFailure(error) });
    }
  }

  private async handleAction(document: ViewerDocument, action: ViewerAction, requestId: string) {
    switch (action.type) {
      case 'copy':
        await vscode.env.clipboard.writeText(action.text);
        return { acknowledged: true } as const;
      case 'openAsText': {
        const textDocument = await vscode.workspace.openTextDocument(document.uri);
        const editor = await vscode.window.showTextDocument(textDocument, { preview: false });
        if (action.physicalLine) {
          const position = new vscode.Position(Math.max(0, action.physicalLine - 1), Math.max(0, (action.column ?? 1) - 1));
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        return { acknowledged: true } as const;
      }
      case 'revealSource':
        await document.revealSource(action.path, action.physicalLine);
        return { acknowledged: true } as const;
      case 'refresh':
        if (document.isDirty) {
          const choice = await vscode.window.showWarningMessage('Refresh will discard unsaved viewer edits.', { modal: true }, 'Discard and Refresh');
          if (choice !== 'Discard and Refresh') throw new vscode.CancellationError();
        }
        await document.refresh();
        return { acknowledged: true } as const;
      case 'save':
        await vscode.commands.executeCommand('workbench.action.files.save');
        return { acknowledged: true } as const;
      case 'saveAs':
        await vscode.commands.executeCommand('workbench.action.files.saveAs');
        return { acknowledged: true } as const;
      case 'undo':
        await vscode.commands.executeCommand('undo');
        return { acknowledged: true } as const;
      case 'redo':
        await vscode.commands.executeCommand('redo');
        return { acknowledged: true } as const;
      default:
        return document.workerRequest(action, requestId);
    }
  }

  saveCustomDocument(document: ViewerDocument, token: vscode.CancellationToken): Thenable<void> {
    return document.save(document.uri, token);
  }

  saveCustomDocumentAs(document: ViewerDocument, destination: vscode.Uri, token: vscode.CancellationToken): Thenable<void> {
    return document.save(destination, token);
  }

  revertCustomDocument(document: ViewerDocument, token: vscode.CancellationToken): Thenable<void> {
    return document.revert(token);
  }

  backupCustomDocument(
    document: ViewerDocument,
    context: vscode.CustomDocumentBackupContext,
    token: vscode.CancellationToken,
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, token);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
