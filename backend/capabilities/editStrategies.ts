import type { EditToolMode } from '../../shared/protocol';
import type { FsHunkEditRequest } from './types';

export interface EditApplyResult {
  mode: EditToolMode;
  newContent: string;
  totalHunks: number;
  applied: number;
  failed: number;
  results: EditApplyHunkResult[];
  fallbackMode?: string;
}

export interface EditApplyHunkResult {
  index: number;
  success: boolean;
  error?: string;
  startLine?: number;
  endLine?: number;
  appliedBy?: string;
  matchCount?: number;
  candidateLines?: number[];
  replacements?: number;
  fallback?: {
    strategy: string;
    message: string;
    originalHeader?: string;
    correctedHeader?: string;
  };
}

export function applyHunkEdit(originalContent: string, hunks: FsHunkEditRequest[]): EditApplyResult {
  let currentContent = normalizeLineEndings(originalContent);
  const results: EditApplyHunkResult[] = [];

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (!hunk || typeof hunk.oldContent !== 'string' || typeof hunk.newContent !== 'string') {
      results.push({ index, success: false, error: `Hunk ${index} must contain string oldContent and newContent.` });
      continue;
    }

    const oldContent = normalizeLineEndings(hunk.oldContent);
    const newContent = normalizeLineEndings(hunk.newContent);
    const replaceAll = hunk.replaceAll === true;
    if (!oldContent) {
      results.push({ index, success: false, error: `Hunk ${index} has empty oldContent. Provide existing file content to locate the replacement.`, matchCount: 0 });
      continue;
    }

    const matches = findAllExactMatchIndexes(currentContent, oldContent);
    const candidateLines = matches.slice(0, 20).map((matchIndex) => getLineNumberAtIndex(currentContent, matchIndex));
    if (matches.length === 0) {
      results.push({ index, success: false, error: `Hunk ${index}: no exact match found for oldContent.`, matchCount: 0 });
      continue;
    }

    const replacementIndexes = replaceAll ? matches : [matches[0]];
    const newFileContent = replaceAtIndexes(currentContent, replacementIndexes, oldContent.length, newContent);
    const firstMatch = replacementIndexes[0];
    const startLine = getLineNumberAtIndex(currentContent, firstMatch);
    const endLine = startLine + Math.max(countTextLines(newContent), 1) - 1;

    currentContent = newFileContent;
    results.push({
      index,
      success: true,
      startLine,
      endLine,
      appliedBy: replaceAll ? 'search_replace_all' : 'search_replace_first',
      matchCount: matches.length,
      replacements: replacementIndexes.length,
      candidateLines
    });
  }

  const applied = results.filter((item) => item.success).length;

  return {
    mode: 'hunk',
    newContent: currentContent,
    totalHunks: hunks.length,
    applied,
    failed: Math.max(0, hunks.length - applied),
    results
  };
}

export function applyInsertEdit(originalContent: string, line: number, content: string): EditApplyResult {
  const normalized = normalizeLineEndings(originalContent);
  const split = splitLinesPreserveTrailing(normalized);
  const lines = split.lines;
  const totalLines = lines.length;

  if (!Number.isFinite(line) || line < 1) {
    return {
      mode: 'insert',
      newContent: normalized,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line number: ${line}. Must be a positive integer (1-based).` }]
    };
  }
  if (line > totalLines + 1) {
    return {
      mode: 'insert',
      newContent: normalized,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Line ${line} is out of range. The file has ${totalLines} lines. Use line ${totalLines + 1} to append at the end.` }]
    };
  }

  const insertText = normalizeLineEndings(content);
  const insertLines = insertText === '' ? [] : insertText.split('\n');
  const insertIndex = line - 1;
  lines.splice(insertIndex, 0, ...insertLines);

  const newContent = joinLinesPreserveTrailing(lines, split.endsWithNewline);
  const endLine = line + Math.max(countTextLines(insertText), 1) - 1;
  return {
    mode: 'insert',
    newContent,
    totalHunks: 1,
    applied: 1,
    failed: 0,
    results: [{ index: 0, success: true, startLine: line, endLine, appliedBy: 'line_number', replacements: 1 }]
  };
}

export function applyDeleteEdit(originalContent: string, startLine: number, endLine: number): EditApplyResult {
  const normalized = normalizeLineEndings(originalContent);
  const split = splitLinesPreserveTrailing(normalized);
  const lines = split.lines;
  const totalLines = lines.length;

  if (!Number.isFinite(startLine) || startLine < 1 || !Number.isFinite(endLine) || endLine < 1) {
    return {
      mode: 'delete',
      newContent: normalized,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line range: startLine=${startLine}, endLine=${endLine}. Both must be positive integers (1-based).` }]
    };
  }
  if (startLine > endLine) {
    return {
      mode: 'delete',
      newContent: normalized,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Invalid line range: startLine (${startLine}) must be ≤ endLine (${endLine}).` }]
    };
  }
  if (startLine > totalLines) {
    return {
      mode: 'delete',
      newContent: normalized,
      totalHunks: 1,
      applied: 0,
      failed: 1,
      results: [{ index: 0, success: false, error: `Line ${startLine} is out of range. The file has ${totalLines} lines.` }]
    };
  }

  const clampedEnd = Math.min(endLine, totalLines);
  const deleteStart = startLine - 1;
  const deleteCount = clampedEnd - deleteStart;
  lines.splice(deleteStart, deleteCount);

  const newContent = joinLinesPreserveTrailing(lines, split.endsWithNewline);
  return {
    mode: 'delete',
    newContent,
    totalHunks: 1,
    applied: 1,
    failed: 0,
    results: [{ index: 0, success: true, startLine, endLine: clampedEnd, appliedBy: 'line_number', replacements: deleteCount }]
  };
}

function splitLinesPreserveTrailing(text: string): { lines: string[]; endsWithNewline: boolean } {
  const normalized = normalizeLineEndings(text);
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

function joinLinesPreserveTrailing(lines: string[], endsWithNewline: boolean): string {
  const body = lines.join('\n');
  return endsWithNewline ? `${body}\n` : body;
}

function findAllExactMatchIndexes(content: string, search: string): number[] {
  if (!search) return [];
  const matches: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= content.length) {
    const found = content.indexOf(search, fromIndex);
    if (found < 0) break;
    matches.push(found);
    fromIndex = found + Math.max(1, search.length);
  }
  return matches;
}

function replaceAtIndexes(content: string, indexes: number[], length: number, replacement: string): string {
  let result = content;
  for (const index of [...indexes].sort((left, right) => right - left)) {
    result = `${result.slice(0, index)}${replacement}${result.slice(index + length)}`;
  }
  return result;
}

function getLineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function countTextLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
