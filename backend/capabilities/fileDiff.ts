import type { FsFileDiffRecord } from './types';

const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_LCS_CELLS = 1_000_000;
const MAX_DIFF_TEXT_CHARS = 120_000;

type DiffOpType = 'ctx' | 'add' | 'del';

interface RawDiffOp {
  type: DiffOpType;
  content: string;
}

interface NumberedDiffOp extends RawDiffOp {
  oldPos: number;
  newPos: number;
  oldNum?: number;
  newNum?: number;
}

export function buildFileDiffRecord(filePath: string, before: string, after: string, existed: boolean): FsFileDiffRecord | undefined {
  const text = buildUnifiedLineDiff(filePath, before, after, existed, DEFAULT_DIFF_CONTEXT_LINES);
  if (!text) return undefined;
  const stats = countDiffStats(text);
  const truncated = truncateDiffText(text);
  return {
    format: 'unified',
    text: truncated.text,
    added: stats.added,
    removed: stats.removed,
    truncated: truncated.truncated
  };
}

export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function buildUnifiedLineDiff(filePath: string, before: string, after: string, existed: boolean, contextLines: number): string {
  if (before === after) return '';
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  const ops = numberDiffOps(buildRawDiffOps(beforeLines, afterLines));
  const ranges = hunkRanges(ops, contextLines);
  if (ranges.length === 0) return '';
  const normalizedPath = normalizeDiffPath(filePath || 'file');
  const oldFile = existed ? `a/${normalizedPath}` : '/dev/null';
  const hunks = ranges.map((range) => formatHunk(ops.slice(range.start, range.end)));
  return [`--- ${oldFile}`, `+++ b/${normalizedPath}`, ...hunks].join('\n');
}

function splitLinesForDiff(text: string): string[] {
  if (!text) return [];
  const lines = normalizeLineEndings(text).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildRawDiffOps(beforeLines: string[], afterLines: string[]): RawDiffOp[] {
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let oldEnd = beforeLines.length;
  let newEnd = afterLines.length;
  while (oldEnd > prefix && newEnd > prefix && beforeLines[oldEnd - 1] === afterLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const ops: RawDiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ type: 'ctx', content: beforeLines[index] });
  ops.push(...diffSegment(beforeLines.slice(prefix, oldEnd), afterLines.slice(prefix, newEnd)));
  for (let index = oldEnd; index < beforeLines.length; index += 1) ops.push({ type: 'ctx', content: beforeLines[index] });
  return ops;
}

function diffSegment(oldLines: string[], newLines: string[]): RawDiffOp[] {
  if (oldLines.length === 0) return newLines.map((content) => ({ type: 'add', content }));
  if (newLines.length === 0) return oldLines.map((content) => ({ type: 'del', content }));

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map((content) => ({ type: 'del' as const, content })),
      ...newLines.map((content) => ({ type: 'add' as const, content }))
    ];
  }

  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const ops: RawDiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'ctx', content: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      ops.push({ type: 'del', content: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: 'add', content: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    ops.push({ type: 'del', content: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    ops.push({ type: 'add', content: newLines[newIndex] });
    newIndex += 1;
  }
  return ops;
}

function numberDiffOps(rawOps: RawDiffOp[]): NumberedDiffOp[] {
  let oldLine = 1;
  let newLine = 1;
  return rawOps.map((op) => {
    const base = { ...op, oldPos: oldLine, newPos: newLine };
    if (op.type === 'ctx') {
      const numbered: NumberedDiffOp = { ...base, oldNum: oldLine, newNum: newLine };
      oldLine += 1;
      newLine += 1;
      return numbered;
    }
    if (op.type === 'del') {
      const numbered: NumberedDiffOp = { ...base, oldNum: oldLine };
      oldLine += 1;
      return numbered;
    }
    const numbered: NumberedDiffOp = { ...base, newNum: newLine };
    newLine += 1;
    return numbered;
  });
}

function hunkRanges(ops: NumberedDiffOp[], contextLines: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type === 'ctx') continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length, index + contextLines + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function formatRangeStart(start: number, count: number): string {
  return `${Math.max(0, start)},${count}`;
}

function formatHunk(ops: NumberedDiffOp[]): string {
  const oldCount = ops.filter((op) => op.type !== 'add').length;
  const newCount = ops.filter((op) => op.type !== 'del').length;
  const first = ops[0];
  const firstOldNum = ops.find((op) => op.oldNum !== undefined)?.oldNum;
  const firstNewNum = ops.find((op) => op.newNum !== undefined)?.newNum;
  const oldStart = oldCount > 0 ? (firstOldNum ?? 0) : Math.max(0, first.oldPos - 1);
  const newStart = newCount > 0 ? (firstNewNum ?? 0) : Math.max(0, first.newPos - 1);
  const lines = ops.map((op) => {
    if (op.type === 'add') return `+${op.content}`;
    if (op.type === 'del') return `-${op.content}`;
    return ` ${op.content}`;
  });
  return [`@@ -${formatRangeStart(oldStart, oldCount)} +${formatRangeStart(newStart, newCount)} @@`, ...lines].join('\n');
}

function truncateDiffText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_TEXT_CHARS) return { text, truncated: false };
  const headLength = Math.floor(MAX_DIFF_TEXT_CHARS * 0.68);
  const tailLength = MAX_DIFF_TEXT_CHARS - headLength;
  return {
    text: `${text.slice(0, headLength)}\n\n... diff 已截断，共 ${text.length} 字符 ...\n\n${text.slice(-tailLength)}`,
    truncated: true
  };
}

function normalizeDiffPath(filePath: string): string {
  return filePath.trim().replace(/\\+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '') || 'file';
}
