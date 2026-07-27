import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    const singleRecordJsonlUri = vscode.Uri.file(join(directory, 'single-record.jsonl'));
    const invalidJsonlUri = vscode.Uri.file(join(directory, 'invalid-utf8.jsonl'));
    await writeFile(jsonUri.fsPath, '{"name":"Ada","items":[1,2,3]}');
    await writeFile(largeJsonUri.fsPath, `{"payload":"${'x'.repeat(11 * 1024 * 1024)}"}`);
    await writeFile(jsonlUri.fsPath, '{"id":1,"ok":true}\nnot-json\n{"id":2,"ok":false}\n');
    await writeFile(singleRecordJsonlUri.fsPath, '{"profile":{"name":"Ada","active":true}}\n');
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

      await customDocument.applyEdit({ kind: 'set', path: ['name'], value: 'Local unsaved edit' });
      await writeFile(jsonUri.fsPath, '{"name":"External edit"}');
      await assert.rejects(customDocument.save(jsonUri, cancellation.token), (error: unknown) => {
        return error instanceof Error && (error as { code?: string }).code === 'SOURCE_CHANGED';
      });
      assert.match(await readFile(jsonUri.fsPath, 'utf8'), /External edit/);
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

    const singleRecordCancellation = new vscode.CancellationTokenSource();
    const singleRecordDocument = await ViewerDocument.open(
      singleRecordJsonlUri,
      'jsonl',
      extension.extensionUri,
      join(directory, 'single-record-cache'),
      undefined,
      singleRecordCancellation.token,
    );
    try {
      assert.equal(singleRecordDocument.bootstrap.kind, 'json');
      assert.equal(singleRecordDocument.bootstrap.openResult?.kind, 'json');
      assert.equal(singleRecordDocument.isEditable, true);
      const children = await singleRecordDocument.workerRequest({ type: 'json/children', pointer: '', offset: 0, limit: 20 }, 'single-record');
      assert.ok('children' in children);
      assert.equal(children.children[0]?.key, 'profile');
      await singleRecordDocument.applyEdit({ kind: 'set', path: ['profile', 'active'], value: false });
      const profile = await singleRecordDocument.workerRequest({ type: 'json/children', pointer: '/profile', offset: 0, limit: 20 }, 'single-record-edited');
      assert.ok('children' in profile);
      assert.equal(profile.children.find((node) => node.key === 'active')?.raw, 'false');
    } finally {
      singleRecordDocument.dispose();
      singleRecordCancellation.dispose();
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

    const slowExtension = join(directory, 'slow-extension');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(join(slowExtension, 'dist')));
    await writeFile(join(slowExtension, 'dist', 'worker.cjs'), `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (message) => {
        if (message.type === 'cancel') {
          parentPort.postMessage({ type: 'response', requestId: message.requestId, ok: true, data: { cancelled: true } });
          return;
        }
        setTimeout(() => parentPort.postMessage({
          type: 'response', requestId: message.requestId, ok: true,
          data: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1 },
        }), 500);
      });
    `);
    const slowClient = new WorkerClient(vscode.Uri.file(slowExtension));
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = slowClient.request({ type: 'diagnostics/memory' }, { signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, (error: unknown) => error instanceof Error && error.message.includes('cancelled'));
      assert.ok(Date.now() - started < 200, 'Client-side cancellation should not wait for a busy worker.');
    } finally {
      slowClient.dispose();
    }

    const guardedPath = join(directory, 'guarded.json');
    await writeFile(guardedPath, '{"items":[1,2,3]}');
    const guardedStat = await stat(guardedPath);
    const guardClient = new WorkerClient(extension.extensionUri);
    try {
      await guardClient.request({
        type: 'session/open', sessionId: 'guarded', kind: 'json',
        source: { type: 'file', path: guardedPath, signature: { size: guardedStat.size, mtimeMs: guardedStat.mtimeMs } },
        settings: {
          editableMaxBytes: 10 * 1024 * 1024, maxJsonBytes: 100 * 1024 * 1024,
          pageSize: 200, schemaSampleRows: 1000, maxLineBytes: 16 * 1024 * 1024,
          sortMaxRows: 1_000_000, indexCacheBytes: 1024 * 1024 * 1024,
        },
        cacheDirectory: join(directory, 'guard-cache'), cacheKey: 'guarded',
      });
      await writeFile(guardedPath, '{"items":[9,2,3]}');
      await assert.rejects(
        guardClient.request({ type: 'json/children', sessionId: 'guarded', pointer: '', offset: 0, limit: 20 }),
        (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'SOURCE_CHANGED',
      );
    } finally {
      guardClient.dispose();
    }
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllGroups');
    await rm(directory, { recursive: true, force: true });
  }
}
