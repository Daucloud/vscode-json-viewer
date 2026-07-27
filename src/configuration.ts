import * as vscode from 'vscode';
import { clampInteger, clampNumber, DEFAULT_SETTINGS } from './shared/settings.js';
import type { PreviewSettings } from './shared/types.js';

const MIB = 1024 * 1024;

export function readSettings(): PreviewSettings {
  const configuration = vscode.workspace.getConfiguration('fastJsonViewer');
  return {
    editableMaxBytes: clampInteger(configuration.get('editableMaxMB'), DEFAULT_SETTINGS.editableMaxBytes / MIB, 1, 100) * MIB,
    maxJsonBytes: clampInteger(configuration.get('maxJsonMB'), DEFAULT_SETTINGS.maxJsonBytes / MIB, 10, 1024) * MIB,
    pageSize: clampInteger(configuration.get('jsonl.pageSize'), DEFAULT_SETTINGS.pageSize, 20, 1000),
    schemaSampleRows: clampInteger(configuration.get('jsonl.schemaSampleRows'), DEFAULT_SETTINGS.schemaSampleRows, 20, 10_000),
    maxLineBytes: Math.floor(clampNumber(configuration.get('jsonl.maxLineMB'), DEFAULT_SETTINGS.maxLineBytes / MIB, 0.1, 256) * MIB),
    sortMaxRows: clampInteger(configuration.get('jsonl.sortMaxRows'), DEFAULT_SETTINGS.sortMaxRows, 1000, 10_000_000),
    indexCacheBytes: clampInteger(configuration.get('indexCacheMB'), DEFAULT_SETTINGS.indexCacheBytes / MIB, 64, 16_384) * MIB,
  };
}
