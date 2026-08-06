import { describe, expect, it } from 'vitest';
import { applyDocumentEdit } from '../../src/worker/editing.js';

describe('worker-side document edits', () => {
  it('sets, adds, renames and deletes JSON nodes while preserving formatting', () => {
    let text = '{\n  "name": "Ada",\n  "items": [1, 2]\n}';
    text = applyDocumentEdit(text, 'json', { kind: 'set', path: ['name'], value: 'Grace' });
    text = applyDocumentEdit(text, 'json', { kind: 'add', path: ['active'], value: true });
    text = applyDocumentEdit(text, 'json', { kind: 'rename', path: ['name'], newKey: 'displayName' });
    text = applyDocumentEdit(text, 'json', { kind: 'delete', path: ['active'] });
    expect(JSON.parse(text)).toEqual({ displayName: 'Grace', items: [1, 2] });
  });

  it('edits one JSONL line without changing neighboring records or CRLF', () => {
    const text = '{"id":1}\r\n{"id":2}\r\n';
    const edited = applyDocumentEdit(text, 'jsonl', { kind: 'set', path: ['id'], value: 20, physicalLine: 2 });
    expect(edited).toBe('{"id":1}\r\n{"id":20}\r\n');
  });

  it('keeps added JSONL properties and array items on one physical line', () => {
    let text = '{}\n{"items":[]}\n';
    text = applyDocumentEdit(text, 'jsonl', {
      kind: 'add', path: ['newProperty'], value: { active: true }, physicalLine: 1,
    });
    text = applyDocumentEdit(text, 'jsonl', {
      kind: 'add', path: ['items', 0], value: 'first', insertArray: true, physicalLine: 2,
    });

    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ newProperty: { active: true } });
    expect(JSON.parse(lines[1]!)).toEqual({ items: ['first'] });
  });

  it('replaces JSONL containers from raw literals without rounding unsafe integers', () => {
    const text = '{"record":{"id":1}}\n{"record":{"id":2}}\n';
    const edited = applyDocumentEdit(text, 'jsonl', {
      kind: 'setRaw',
      path: ['record'],
      raw: '{\n  "id": 900719925474099312345,\n  "message": "space kept"\n}',
      physicalLine: 2,
    });
    expect(edited).toBe('{"record":{"id":1}}\n{"record":{"id":900719925474099312345,"message":"space kept"}}\n');
  });

  it('rejects malformed raw value edits', () => {
    expect(() => applyDocumentEdit('{"value":1}', 'json', { kind: 'setRaw', path: ['value'], raw: '{oops' })).toThrow(/valid JSON value/i);
  });

  it('rejects JSONL edits without a selected physical line', () => {
    expect(() => applyDocumentEdit('{"id":1}', 'jsonl', { kind: 'set', path: ['id'], value: 2 })).toThrow(/record|line/i);
  });
});
