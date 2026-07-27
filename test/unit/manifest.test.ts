import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
  main: string;
  extensionKind: string[];
  capabilities: {
    untrustedWorkspaces: { supported: boolean };
  };
  contributes: {
    customEditors: Array<{ viewType: string; priority: string; selector: Array<{ filenamePattern: string }> }>;
    commands: Array<{ command: string }>;
    configuration: { properties: Record<string, { default: number }> };
  };
};

describe('extension manifest', () => {
  it('declares desktop/workspace custom editor priorities', () => {
    expect(manifest.main).toBe('./dist/extension.cjs');
    expect(manifest.extensionKind).toContain('workspace');
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
    const json = manifest.contributes.customEditors.find((editor) => editor.viewType === 'fastJsonViewer.json');
    const jsonl = manifest.contributes.customEditors.find((editor) => editor.viewType === 'fastJsonViewer.jsonl');
    expect(json?.priority).toBe('option');
    expect(jsonl?.priority).toBe('default');
    expect(jsonl?.selector.map((entry) => entry.filenamePattern)).toEqual(expect.arrayContaining(['*.jsonl', '*.ndjson']));
  });

  it('exposes the documented commands and safety limits', () => {
    const commands = manifest.contributes.commands.map((command) => command.command);
    expect(commands).toEqual(expect.arrayContaining([
      'fastJsonViewer.open', 'fastJsonViewer.refresh', 'fastJsonViewer.openAsText', 'fastJsonViewer.clearIndexCache',
    ]));
    const properties = manifest.contributes.configuration.properties;
    expect(properties['fastJsonViewer.editableMaxMB']?.default).toBe(10);
    expect(properties['fastJsonViewer.maxJsonMB']?.default).toBe(100);
    expect(properties['fastJsonViewer.jsonl.pageSize']?.default).toBe(200);
    expect(properties['fastJsonViewer.indexCacheMB']?.default).toBe(1024);
  });
});
