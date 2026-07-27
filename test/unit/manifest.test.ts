import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
  description: string;
  categories: string[];
  keywords: string[];
  main: string;
  icon: string;
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
  it('ships the Marketplace icon declared by the manifest', async () => {
    expect(manifest.icon).toBe('media/icon.png');
    const icon = await readFile(new URL(`../../${manifest.icon}`, import.meta.url));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('publishes focused Marketplace discovery metadata', () => {
    expect(manifest.description).toMatch(/JSON, JSONL, and NDJSON viewer/i);
    expect(manifest.categories).toEqual(expect.arrayContaining(['Visualization', 'Data Science']));
    expect(manifest.keywords).toEqual(expect.arrayContaining([
      'json viewer', 'json tree', 'large json', 'jsonl viewer', 'ndjson viewer', 'large file viewer',
    ]));
    expect(new Set(manifest.keywords).size).toBe(manifest.keywords.length);
  });

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
