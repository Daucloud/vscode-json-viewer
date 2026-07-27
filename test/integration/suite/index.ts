import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ViewerDocument, type ViewerDocumentEdit } from '../../../src/viewerDocument.js';
import { WorkerClient } from '../../../src/workerClient.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for VS Code custom editor.');
    await delay(100);
  }
}

function activeCustomView(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.viewType : undefined;
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('daucloud.vscode-json-viewer');
  assert.ok(extension, 'The Fast JSON Viewer extension did not activate in the test host.');
  await extension.activate();
  const directory = await mkdtemp(join(tmpdir(), 'fast-json-viewer-vscode-test-'));
  try {
    const jsonUri = vscode.Uri.file(join(directory, 'small.json'));
    const largeJsonUri = vscode.Uri.file(join(directory, 'large.json'));
    const jsonlUri = vscode.Uri.file(join(directory, 'records.jsonl'));
    const invalidJsonlUri = vscode.Uri.file(join(directory, 'invalid-utf8.jsonl'));
    await writeFile(jsonUri.fsPath, '{"name":"Ada","items":[1,2,3]}');
    await writeFile(largeJsonUri.fsPath, `{"payload":"${'x'.repeat(11 * 1024 * 1024)}"}`);
    await writeFile(jsonlUri.fsPath, '{"id":1,"ok":true}\nnot-json\n{"id":2,"ok":false}\n');
    await writeFile(invalidJsonlUri.fsPath, Buffer.concat([Buffer.from('{"id":"'), Buffer.from([0xff]), Buffer.from('"}\n{"id":2}\n')]));

    await vscode.commands.executeCommand('vscode.openWith', jsonUri, 'fastJsonViewer.json');
    await waitFor(() => activeCustomView() === 'fastJsonViewer.json');
    assert.equal(activeCustomView(), 'fastJsonViewer.json');

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('vscode.open', jsonlUri);
    await waitFor(() => activeCustomView() === 'fastJsonViewer.jsonl');
    assert.equal(activeCustomView(), 'fastJsonViewer.jsonl');

    const packageJson = JSON.parse(await readFile(join(extension.extensionPath, 'package.json'), 'utf8')) as {
      contributes: { customEditors: Array<{ viewType: string; priority: string }> };
    };
    const editors = packageJson.contributes.customEditors;
    assert.equal(editors.find((editor) => editor.viewType === 'fastJsonViewer.json')?.priority, 'option');
    assert.equal(editors.find((editor) => editor.viewType === 'fastJsonViewer.jsonl')?.priority, 'default');

    const cancellation = new vscode.CancellationTokenSource();
    const customDocument = await ViewerDocument.open(
      jsonUri,
      'json',
      extension.extensionUri,
      join(directory, 'cache'),
      undefined,
      cancellation.token,
    );
    try {
      assert.equal(customDocument.isEditable, true);
      let historyEdit: ViewerDocumentEdit | undefined;
      const editSubscription = customDocument.onDidEdit((edit) => { historyEdit = edit; });
      await customDocument.applyEdit({ kind: 'set', path: ['name'], value: 'Grace' });
      assert.ok(historyEdit, 'The edit did not participate in the custom document undo stack.');

      const changed = await customDocument.workerRequest({ type: 'json/children', pointer: '', offset: 0, limit: 20 }, 'changed');
      assert.ok('children' in changed);
      assert.equal(changed.children.find((node) => node.key === 'name')?.raw, '"Grace"');

      await historyEdit.undo();
      const undone = await customDocument.workerRequest({ type: 'json/children', pointer: '', offset: 0, limit: 20 }, 'undone');
      assert.ok('children' in undone);
      assert.equal(undone.children.find((node) => node.key === 'name')?.raw, '"Ada"');

      await historyEdit.redo();
      const backupUri = vscode.Uri.file(join(directory, 'hot-exit.backup'));
      const backup = await customDocument.backup(backupUri, cancellation.token);
      assert.match(await readFile(backupUri.fsPath, 'utf8'), /"Grace"/);
      const restored = await ViewerDocument.open(jsonUri, 'json', extension.extensionUri, join(directory, 'restored-cache'), backup.id, cancellation.token);
      assert.equal(restored.isDirty, true);
      restored.dispose();
      await backup.delete();

      const saveAsUri = vscode.Uri.file(join(directory, 'saved-as.json'));
      await customDocument.save(saveAsUri, cancellation.token);
      assert.match(await readFile(saveAsUri.fsPath, 'utf8'), /"Grace"/);
      await customDocument.save(jsonUri, cancellation.token);
      assert.equal(customDocument.isDirty, false);
      assert.match(await readFile(jsonUri.fsPath, 'utf8'), /"Grace"/);
      editSubscription.dispose();
    } finally {
      customDocument.dispose();
      cancellation.dispose();
    }

    const invalidCancellation = new vscode.CancellationTokenSource();
    const invalidDocument = await ViewerDocument.open(
      invalidJsonlUri,
      'jsonl',
      extension.extensionUri,
      join(directory, 'invalid-cache'),
      undefined,
      invalidCancellation.token,
    );
    try {
      assert.equal(invalidDocument.isEditable, false);
      assert.equal(invalidDocument.bootstrap.mode, 'readonly');
    } finally {
      invalidDocument.dispose();
      invalidCancellation.dispose();
    }

    const largeCancellation = new vscode.CancellationTokenSource();
    const largeDocument = await ViewerDocument.open(
      largeJsonUri,
      'json',
      extension.extensionUri,
      join(directory, 'large-cache'),
      undefined,
      largeCancellation.token,
    );
    try {
      assert.equal(largeDocument.bootstrap.mode, 'readonly');
      const initialOpenResult = largeDocument.bootstrap.openResult;
      assert.equal(initialOpenResult, undefined, 'Large JSON should resolve the custom editor before parsing completes.');
      await waitFor(() => largeDocument.bootstrap.openResult?.kind === 'json');
      assert.equal(largeDocument.bootstrap.openResult?.kind, 'json');
    } finally {
      largeDocument.dispose();
      largeCancellation.dispose();
    }

    const crashExtension = join(directory, 'crash-extension');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(join(crashExtension, 'dist')));
    await writeFile(join(crashExtension, 'dist', 'worker.cjs'), 'process.exit(17);');
    const crashClient = new WorkerClient(vscode.Uri.file(crashExtension));
    try {
      const crashed = new Promise<string>((resolve) => crashClient.onDidCrash(resolve));
      await assert.rejects(crashClient.request({ type: 'diagnostics/memory' }), (error: unknown) => {
        return error instanceof Error && /stopped unexpectedly|Worker error/.test(error.message);
      });
      assert.match(await crashed, /stopped unexpectedly|Worker error/);
    } finally {
      crashClient.dispose();
    }
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await rm(directory, { recursive: true, force: true });
  }
}
