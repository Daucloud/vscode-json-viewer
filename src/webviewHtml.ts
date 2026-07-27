import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; object-src 'none'; base-uri 'none';">
  <link rel="stylesheet" href="${style}">
  <title>Fast JSON Viewer</title>
</head>
<body>
  <div id="root" role="application" aria-label="Fast JSON Viewer"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
