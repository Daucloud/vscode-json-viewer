import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type FormattingOptions, type JSONPath } from 'jsonc-parser';
import type { JsonEditOperation } from '../shared/types.js';
import { PreviewError } from './errors.js';

interface LineSlice { start: number; end: number; text: string }

function formattingFor(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentation = /(?:^|\r?\n)([ \t]+)["}\]]/m.exec(text)?.[1] ?? '  ';
  return {
    eol,
    insertSpaces: !indentation.includes('\t'),
    tabSize: indentation.includes('\t') ? 1 : Math.max(1, Math.min(8, indentation.length)),
  };
}

function lineAt(text: string, physicalLine: number): LineSlice {
  if (!Number.isInteger(physicalLine) || physicalLine < 1) throw new PreviewError('LINE_NOT_FOUND', 'Invalid JSONL line number.');
  let line = 1;
  let start = 0;
  while (line < physicalLine) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) throw new PreviewError('LINE_NOT_FOUND', `Line ${physicalLine} does not exist.`);
    start = newline + 1;
    line++;
  }
  const newline = text.indexOf('\n', start);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text.charCodeAt(end - 1) === 0x0d) end--;
  return { start, end, text: text.slice(start, end) };
}

function compactJsonWhitespace(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') {
      output += character;
    }
  }
  return output;
}

function validatedRawLiteral(raw: string, compact: boolean): string {
  const literal = raw.trim();
  if (!literal) throw new PreviewError('INVALID_EDIT', 'Enter a valid JSON value.');
  try {
    JSON.parse(literal);
  } catch (error) {
    throw new PreviewError('INVALID_EDIT', `Enter a valid JSON value: ${error instanceof Error ? error.message : String(error)}`);
  }
  return compact ? compactJsonWhitespace(literal) : literal;
}

export function applyJsonEdit(source: string, edit: JsonEditOperation, compact = false): string {
  const bom = source.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const text = bom ? source.slice(1) : source;
  const path = [...edit.path] as JSONPath;
  const formattingOptions = compact ? undefined : formattingFor(text);
  const options = formattingOptions ? { formattingOptions } : {};
  let result: string;

  if (edit.kind === 'setRaw') {
    const tree = parseTree(text);
    const node = tree ? findNodeAtLocation(tree, path) : undefined;
    if (!node) throw new PreviewError('POINTER_NOT_FOUND', 'The selected value no longer exists.');
    const literal = validatedRawLiteral(edit.raw, compact);
    result = `${text.slice(0, node.offset)}${literal}${text.slice(node.offset + node.length)}`;
  } else if (edit.kind === 'rename') {
    if (path.length === 0 || !edit.newKey.trim()) throw new PreviewError('INVALID_EDIT', 'A property name is required.');
    const oldKey = path[path.length - 1];
    if (typeof oldKey !== 'string') throw new PreviewError('INVALID_EDIT', 'Array items cannot be renamed.');
    const tree = parseTree(text);
    const node = tree ? findNodeAtLocation(tree, path) : undefined;
    if (!node) throw new PreviewError('POINTER_NOT_FOUND', 'The selected property no longer exists.');
    const parentPath = path.slice(0, -1);
    if (tree && findNodeAtLocation(tree, [...parentPath, edit.newKey])) {
      throw new PreviewError('DUPLICATE_KEY', `The property “${edit.newKey}” already exists.`);
    }
    const value = getNodeValue(node) as unknown;
    const removed = applyEdits(text, modify(text, path, undefined, options));
    result = applyEdits(removed, modify(removed, [...parentPath, edit.newKey], value, compact ? {} : { formattingOptions: formattingFor(removed) }));
  } else {
    const value = edit.kind === 'delete' ? undefined : edit.value;
    result = applyEdits(text, modify(text, path, value, {
      ...options,
      ...(edit.kind === 'add' && edit.insertArray ? { isArrayInsertion: true } : {}),
    }));
  }
  return `${bom}${result}`;
}

export function applyDocumentEdit(source: string, kind: 'json' | 'jsonl', edit: JsonEditOperation): string {
  if (kind !== 'jsonl') return applyJsonEdit(source, edit);
  if (edit.physicalLine === undefined) throw new PreviewError('LINE_REQUIRED', 'Select a JSONL record before editing.');
  const line = lineAt(source, edit.physicalLine);
  // A JSONL record must remain one physical line. Supplying formatting options
  // to jsonc-parser pretty-prints additions and turns one valid record into
  // several invalid rows (the first one is often just "{"). Its compact edit
  // mode preserves the surrounding source while keeping inserted values inline.
  const revised = applyJsonEdit(line.text, edit, true);
  return `${source.slice(0, line.start)}${revised}${source.slice(line.end)}`;
}
