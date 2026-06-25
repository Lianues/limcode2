import type { EditToolMode } from '../../shared/protocol';
import type { FsStructuredEditHunk } from './types';

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
  fallback?: {
    strategy: string;
    message: string;
    originalHeader?: string;
    correctedHeader?: string;
  };
}

type UnifiedDiffLineType = 'context' | 'add' | 'del';

interface UnifiedDiffLine {
  type: UnifiedDiffLineType;
  content: string;
  raw: string;
}

interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: UnifiedDiffLine[];
}

interface ParsedUnifiedDiff {
  oldFile?: string;
  newFile?: string;
  hunks: UnifiedDiffHunk[];
}

interface SearchReplaceBlock {
  search: string;
  replace: string;
  startLine?: number;
  originalHeader?: string;
}

interface SearchReplaceApplyResult extends EditApplyHunkResult {
  replacementText?: string;
}

type StructuredMatchKind = 'exact' | 'indent_fallback';

interface StructuredLineSpan {
  content: string;
  newline: '' | '\n';
  startIndex: number;
  endIndex: number;
  lineNumber: number;
}

interface StructuredMatchCandidate {
  startIndex: number;
  endIndex: number;
  startLine: number;
  matchedOldContent: string;
}

interface ResolvedStructuredMatch {
  kind: StructuredMatchKind;
  startIndex: number;
  endIndex: number;
  startLine: number;
  matchCount: number;
  candidateLines?: number[];
  matchedOldContent: string;
  replacementContent: string;
}

export function applyPatchEdit(originalContent: string, patch: string): EditApplyResult {
  try {
    const parsed = parseUnifiedDiff(patch);
    let applied = applyUnifiedDiffBestEffort(originalContent, parsed);
    let fallbackMode = applied.fallbackMode;
    const totalHunks = parsed.hunks.length;
    const appliedCount = applied.results.filter((item) => item.success).length;

    if (appliedCount < totalHunks) {
      const searchReplace = applySearchReplaceBestEffort(originalContent, convertUnifiedHunksToSearchReplace(parsed.hunks), 'unified_hunks_search_replace');
      const fallbackAppliedCount = searchReplace.results.filter((item) => item.success).length;
      if (fallbackAppliedCount > appliedCount) {
        applied = searchReplace;
        fallbackMode = 'unified_hunks_search_replace';
      }
    }

    const appliedFinal = applied.results.filter((item) => item.success).length;
    return {
      mode: 'patch',
      newContent: applied.newContent,
      totalHunks,
      applied: appliedFinal,
      failed: Math.max(0, totalHunks - appliedFinal),
      results: applied.results,
      ...(fallbackMode ? { fallbackMode } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('Invalid hunk header')) throw error;
    const blocks = parseLoosePatchToSearchReplace(patch);
    const applied = applySearchReplaceBestEffort(originalContent, blocks, 'loose_hunk_search_replace');
    const appliedCount = applied.results.filter((item) => item.success).length;
    return {
      mode: 'patch',
      newContent: applied.newContent,
      totalHunks: blocks.length,
      applied: appliedCount,
      failed: Math.max(0, blocks.length - appliedCount),
      results: applied.results,
      fallbackMode: 'loose_hunk_search_replace'
    };
  }
}

export function applyHunkEdit(originalContent: string, hunks: FsStructuredEditHunk[]): EditApplyResult {
  let currentContent = normalizeLineEndings(originalContent);
  let lineDelta = 0;
  const results: EditApplyHunkResult[] = [];

  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (!hunk || typeof hunk.oldContent !== 'string' || typeof hunk.newContent !== 'string') {
      results.push({ index, success: false, error: `Hunk ${index} must contain string oldContent and newContent.` });
      continue;
    }

    const oldContent = normalizeLineEndings(hunk.oldContent);
    const newContent = normalizeLineEndings(hunk.newContent);
    if (!oldContent) {
      results.push({ index, success: false, error: `Hunk ${index} has empty oldContent. Provide enough existing content to locate the change.` });
      continue;
    }

    const resolved = resolveStructuredHunkMatch(currentContent, oldContent, newContent, hunk, lineDelta);
    if (resolved.success === false) {
      results.push({
        index,
        success: false,
        error: resolved.error,
        matchCount: resolved.matchCount,
        candidateLines: resolved.candidateLines
      });
      continue;
    }

    const match = resolved.match;
    const endLine = match.startLine + Math.max(countTextLines(match.replacementContent), 1) - 1;
    currentContent = `${currentContent.slice(0, match.startIndex)}${match.replacementContent}${currentContent.slice(match.endIndex)}`;
    lineDelta += countLineBreaks(match.replacementContent) - countLineBreaks(match.matchedOldContent);
    results.push({
      index,
      success: true,
      startLine: match.startLine,
      endLine,
      appliedBy: match.kind,
      matchCount: match.matchCount,
      candidateLines: match.candidateLines
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
    results: [{ index: 0, success: true, startLine: line, endLine, appliedBy: 'line_number' }]
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
    results: [{ index: 0, success: true, startLine, endLine: clampedEnd, appliedBy: 'line_number' }]
  };
}


function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
  const lines = sanitizePatch(patch).split('\n');
  let oldFile: string | undefined;
  let newFile: string | undefined;
  const hunks: UnifiedDiffHunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('diff --git ')) {
      if (hunks.length > 0 || oldFile || newFile) throw new Error('Multi-file patch is not supported. Use one edit call per file.');
      index += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (oldFile && (hunks.length > 0 || newFile)) throw new Error('Multi-file patch is not supported. Use one edit call per file.');
      oldFile = parseFileHeaderPath(line, '---');
      index += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (newFile && hunks.length > 0) throw new Error('Multi-file patch is not supported. Use one edit call per file.');
      newFile = parseFileHeaderPath(line, '+++');
      index += 1;
      continue;
    }
    if (!line.startsWith('@@')) {
      index += 1;
      continue;
    }

    const header = line;
    const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) {
      throw new Error(`Invalid hunk header: ${header}. Expected format: @@ -oldStart,oldCount +newStart,newCount @@.`);
    }

    const hunkLines: UnifiedDiffLine[] = [];
    index += 1;
    while (index < lines.length) {
      const hunkLine = lines[index];
      if (hunkLine.startsWith('@@') || hunkLine.startsWith('--- ') || hunkLine.startsWith('+++ ') || hunkLine.startsWith('diff --git ')) break;
      if (hunkLine === '') {
        index += 1;
        continue;
      }
      if (hunkLine.startsWith('\\')) {
        index += 1;
        continue;
      }
      const prefix = hunkLine[0];
      const content = hunkLine.slice(1);
      if (prefix === ' ') hunkLines.push({ type: 'context', content, raw: hunkLine });
      else if (prefix === '+') hunkLines.push({ type: 'add', content, raw: hunkLine });
      else if (prefix === '-') hunkLines.push({ type: 'del', content, raw: hunkLine });
      else throw new Error(`Invalid hunk line prefix '${prefix}' in line: ${hunkLine}`);
      index += 1;
    }

    hunks.push({
      oldStart: Number.parseInt(match[1], 10),
      oldLines: match[2] ? Number.parseInt(match[2], 10) : 1,
      newStart: Number.parseInt(match[3], 10),
      newLines: match[4] ? Number.parseInt(match[4], 10) : 1,
      header,
      lines: hunkLines
    });
  }

  if (oldFile === '/dev/null' || newFile === '/dev/null') throw new Error('Patches creating/deleting files via /dev/null are not supported. Use write/delete tools instead.');
  if (hunks.length === 0) throw new Error('No hunks (@@ ... @@) found in patch.');
  return { oldFile, newFile, hunks };
}

function applyUnifiedDiffBestEffort(originalContent: string, parsed: ParsedUnifiedDiff): { newContent: string; results: EditApplyHunkResult[]; fallbackMode?: string } {
  const split = splitLinesPreserveTrailing(originalContent);
  const lines = split.lines;
  let delta = 0;
  const results: EditApplyHunkResult[] = [];
  let usedFallback = false;

  for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex += 1) {
    const hunk = parsed.hunks[hunkIndex];
    const tryApplyAt = (startIndex: number): { added: number; removed: number; startLine: number; endLine: number } => {
      if (startIndex < 0 || startIndex > lines.length) throw new Error(`Hunk start is out of range. ${hunk.header}`);
      let cursor = startIndex;
      let added = 0;
      let removed = 0;
      for (const line of hunk.lines) {
        if (line.type === 'context') {
          if (lines[cursor] !== line.content) throw new Error(`Hunk context mismatch at ${hunk.header}. Expected ${JSON.stringify(line.content)}, actual ${JSON.stringify(lines[cursor])}.`);
          cursor += 1;
        } else if (line.type === 'del') {
          if (lines[cursor] !== line.content) throw new Error(`Hunk delete mismatch at ${hunk.header}. Expected ${JSON.stringify(line.content)}, actual ${JSON.stringify(lines[cursor])}.`);
          lines.splice(cursor, 1);
          removed += 1;
        } else {
          lines.splice(cursor, 0, line.content);
          cursor += 1;
          added += 1;
        }
      }
      const startLine = startIndex + 1;
      const endLine = startLine + Math.max(computeHunkNewLen(hunk), 1) - 1;
      return { added, removed, startLine, endLine };
    };

    const snapshot = [...lines];
    try {
      const startIndex = Math.max(1, hunk.oldStart) - 1 + delta;
      const applied = tryApplyAt(startIndex);
      delta += applied.added - applied.removed;
      results.push({ index: hunkIndex, success: true, startLine: applied.startLine, endLine: applied.endLine, appliedBy: 'line_number' });
      continue;
    } catch {
      lines.splice(0, lines.length, ...snapshot);
    }

    const matches = searchHunkInLines(lines, hunk);
    if (matches.length === 1) {
      const fallbackSnapshot = [...lines];
      try {
        const applied = tryApplyAt(matches[0]);
        delta += applied.added - applied.removed;
        usedFallback = true;
        results.push({
          index: hunkIndex,
          success: true,
          startLine: applied.startLine,
          endLine: applied.endLine,
          appliedBy: 'context_search',
          fallback: { strategy: 'context_search', message: 'Line-number match failed; applied by unique context/delete block search.', originalHeader: hunk.header }
        });
        continue;
      } catch (error) {
        lines.splice(0, lines.length, ...fallbackSnapshot);
        results.push({ index: hunkIndex, success: false, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }

    const oldLines = hunk.lines.filter((line) => line.type === 'context' || line.type === 'del').map((line) => line.content);
    const error = matches.length === 0
      ? `Hunk context mismatch at ${hunk.header}. Line-number match failed and global search found no match for the context/delete block (${oldLines.length} lines).`
      : `Hunk context mismatch at ${hunk.header}. Line-number match failed and global search found ${matches.length} matches (ambiguous). Candidate lines: ${matches.map((item) => item + 1).join(', ')}.`;
    results.push({ index: hunkIndex, success: false, error, candidateLines: matches.map((item) => item + 1), matchCount: matches.length });
  }

  return {
    newContent: joinLinesPreserveTrailing(lines, split.endsWithNewline),
    results,
    ...(usedFallback ? { fallbackMode: 'context_search' } : {})
  };
}

function applySearchReplaceBestEffort(originalContent: string, blocks: SearchReplaceBlock[], fallbackMode: string): { newContent: string; results: EditApplyHunkResult[]; fallbackMode: string } {
  let currentContent = normalizeLineEndings(originalContent);
  const results: EditApplyHunkResult[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const applied = applySearchReplace(currentContent, block.search, block.replace, block.startLine);
    if (applied.success) {
      currentContent = applied.result;
      results.push({
        index,
        success: true,
        startLine: applied.matchedLine,
        endLine: applied.matchedLine !== undefined ? applied.matchedLine + Math.max(countTextLines(block.replace), 1) - 1 : undefined,
        appliedBy: fallbackMode,
        fallback: { strategy: fallbackMode, message: `Applied by ${fallbackMode}.`, originalHeader: block.originalHeader },
        matchCount: applied.matchCount,
        candidateLines: applied.candidateLines
      });
    } else {
      results.push({ index, success: false, error: applied.error, matchCount: applied.matchCount, candidateLines: applied.candidateLines });
    }
  }

  return { newContent: currentContent, results, fallbackMode };
}

function applySearchReplace(content: string, search: string, replace: string, startLine?: number): { success: true; result: string; matchCount: number; matchedLine: number; candidateLines?: number[] } | { success: false; result: string; error: string; matchCount: number; candidateLines?: number[] } {
  const normalizedContent = normalizeLineEndings(content);
  const normalizedSearch = normalizeLineEndings(search);
  const normalizedReplace = normalizeLineEndings(replace);
  if (!normalizedSearch) return { success: false, result: normalizedContent, error: 'Search content is empty.', matchCount: 0 };

  if (startLine !== undefined) {
    const startOffset = getCharOffsetForLine(normalizedContent, startLine);
    if (startOffset === undefined) return { success: false, result: normalizedContent, error: `startLine ${startLine} is outside the file.`, matchCount: 0 };
    const found = normalizedContent.indexOf(normalizedSearch, startOffset);
    if (found < 0) return { success: false, result: normalizedContent, error: `No match found at or after startLine ${startLine}.`, matchCount: 0 };
    return {
      success: true,
      result: replaceAt(normalizedContent, found, normalizedSearch.length, normalizedReplace),
      matchCount: 1,
      matchedLine: getLineNumberAtIndex(normalizedContent, found)
    };
  }

  const matches = findAllExactMatchIndexes(normalizedContent, normalizedSearch);
  const candidateLines = matches.slice(0, 20).map((index) => getLineNumberAtIndex(normalizedContent, index));
  if (matches.length === 0) return { success: false, result: normalizedContent, error: 'No exact match found for search block.', matchCount: 0 };
  if (matches.length > 1) return { success: false, result: normalizedContent, error: `Multiple matches found (${matches.length}). Provide more context or line numbers. Candidate lines: ${candidateLines.join(', ')}.`, matchCount: matches.length, candidateLines };
  return {
    success: true,
    result: replaceAt(normalizedContent, matches[0], normalizedSearch.length, normalizedReplace),
    matchCount: 1,
    matchedLine: getLineNumberAtIndex(normalizedContent, matches[0]),
    candidateLines
  };
}

function resolveStructuredHunkMatch(currentContent: string, oldContent: string, newContent: string, hunk: FsStructuredEditHunk, lineDelta: number): { success: true; match: ResolvedStructuredMatch } | { success: false; error: string; matchCount?: number; candidateLines?: number[] } {
  const matches = findAllExactMatchIndexes(currentContent, oldContent);
  if (matches.length === 1) {
    const startIndex = matches[0];
    return { success: true, match: { kind: 'exact', startIndex, endIndex: startIndex + oldContent.length, startLine: getLineNumberAtIndex(currentContent, startIndex), matchCount: 1, matchedOldContent: oldContent, replacementContent: newContent } };
  }
  if (matches.length > 1) {
    const candidateLines = matches.map((index) => getLineNumberAtIndex(currentContent, index));
    if (hunk.startLine === undefined) return { success: false, error: `Multiple matches found (${matches.length}). Provide startLine. Candidate lines: ${candidateLines.join(', ')}.`, matchCount: matches.length, candidateLines };
    const adjustedStartLine = hunk.startLine + lineDelta;
    const startOffset = getCharOffsetForLine(currentContent, adjustedStartLine);
    if (startOffset === undefined) return { success: false, error: `startLine ${hunk.startLine} adjusted to ${adjustedStartLine}, outside current file.`, matchCount: matches.length, candidateLines };
    const startIndex = matches.find((index) => index >= startOffset);
    if (startIndex === undefined) return { success: false, error: `Multiple matches found, but none at or after adjusted startLine ${adjustedStartLine}. Candidate lines: ${candidateLines.join(', ')}.`, matchCount: matches.length, candidateLines };
    return { success: true, match: { kind: 'exact', startIndex, endIndex: startIndex + oldContent.length, startLine: getLineNumberAtIndex(currentContent, startIndex), matchCount: matches.length, candidateLines, matchedOldContent: oldContent, replacementContent: newContent } };
  }

  const fallback = findIndentFallbackCandidates(currentContent, oldContent);
  if (fallback.disabledReason) return { success: false, error: `No exact match found. Indentation fallback not attempted: ${fallback.disabledReason}`, matchCount: 0 };
  if (fallback.candidates.length === 0) return { success: false, error: 'No exact match found. Indentation fallback also found no candidate block.', matchCount: 0 };
  const candidateLines = fallback.candidates.map((candidate) => candidate.startLine);
  let candidate: StructuredMatchCandidate | undefined;
  if (fallback.candidates.length === 1) candidate = fallback.candidates[0];
  else {
    if (hunk.startLine === undefined) return { success: false, error: `Indentation fallback found multiple candidates (${fallback.candidates.length}). Provide startLine. Candidate lines: ${candidateLines.join(', ')}.`, matchCount: fallback.candidates.length, candidateLines };
    const adjustedStartLine = hunk.startLine + lineDelta;
    const startOffset = getCharOffsetForLine(currentContent, adjustedStartLine);
    if (startOffset === undefined) return { success: false, error: `Indentation fallback candidates exist, but adjusted startLine ${adjustedStartLine} is outside current file.`, matchCount: fallback.candidates.length, candidateLines };
    candidate = fallback.candidates.find((item) => item.startIndex >= startOffset);
    if (!candidate) return { success: false, error: `Indentation fallback found multiple candidates, but none at or after adjusted startLine ${adjustedStartLine}. Candidate lines: ${candidateLines.join(', ')}.`, matchCount: fallback.candidates.length, candidateLines };
  }

  return {
    success: true,
    match: {
      kind: 'indent_fallback',
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      startLine: candidate.startLine,
      matchCount: fallback.candidates.length,
      candidateLines: fallback.candidates.length > 1 ? candidateLines : undefined,
      matchedOldContent: candidate.matchedOldContent,
      replacementContent: remapNewContentIndentation(oldContent, newContent, candidate.matchedOldContent)
    }
  };
}

function findIndentFallbackCandidates(content: string, oldContent: string): { candidates: StructuredMatchCandidate[]; disabledReason?: string } {
  const contentLines = tokenizeLinesWithSpans(content);
  const searchLines = tokenizeLinesWithSpans(oldContent);
  if (searchLines.length === 0) return { candidates: [], disabledReason: 'oldContent has no logical lines.' };
  if (!searchLines.some((line) => stripLeadingWhitespace(line.content).trim().length > 0)) return { candidates: [], disabledReason: 'oldContent contains only blank or indentation-only lines.' };
  if (searchLines.length > contentLines.length) return { candidates: [] };
  const candidates: StructuredMatchCandidate[] = [];

  for (let start = 0; start <= contentLines.length - searchLines.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < searchLines.length; offset += 1) {
      const searchLine = searchLines[offset];
      const contentLine = contentLines[start + offset];
      if (stripLeadingWhitespace(searchLine.content) !== stripLeadingWhitespace(contentLine.content)) {
        ok = false;
        break;
      }
      if (searchLine.newline === '\n' && contentLine.newline !== '\n') {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const first = contentLines[start];
    const lastSearch = searchLines[searchLines.length - 1];
    const lastContent = contentLines[start + searchLines.length - 1];
    const endIndex = lastSearch.newline === '\n' ? lastContent.endIndex : lastContent.startIndex + lastContent.content.length;
    candidates.push({ startIndex: first.startIndex, endIndex, startLine: first.lineNumber, matchedOldContent: content.slice(first.startIndex, endIndex) });
  }

  return { candidates };
}

function remapNewContentIndentation(oldContent: string, newContent: string, matchedOldContent: string): string {
  const oldLines = tokenizeLinesWithSpans(oldContent);
  const newLines = tokenizeLinesWithSpans(newContent);
  const matchedLines = tokenizeLinesWithSpans(matchedOldContent);
  if (newLines.length === 0) return '';
  return newLines.map((line, index) => {
    if (stripLeadingWhitespace(line.content).trim().length === 0) return line.content + line.newline;
    const oldLine = oldLines[Math.min(index, oldLines.length - 1)];
    const matchedLine = matchedLines[Math.min(index, matchedLines.length - 1)];
    if (!oldLine || !matchedLine) return line.content + line.newline;
    const modelAnchorIndent = leadingWhitespace(oldLine.content);
    const realAnchorIndent = leadingWhitespace(matchedLine.content);
    const modelLineIndent = leadingWhitespace(line.content);
    if (!modelLineIndent.startsWith(modelAnchorIndent)) return line.content + line.newline;
    return realAnchorIndent + line.content.slice(modelAnchorIndent.length) + line.newline;
  }).join('');
}

function parseLoosePatchToSearchReplace(patch: string): SearchReplaceBlock[] {
  const lines = sanitizePatch(patch).split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let inHunk = false;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];
  let currentHeader: string | undefined;
  const flush = (): void => {
    if (!inHunk) return;
    const search = searchLines.join('\n');
    const replace = replaceLines.join('\n');
    if (!search.trim()) throw new Error('Loose @@ hunk has empty search block. Provide context lines.');
    blocks.push({ search, replace, originalHeader: currentHeader });
    searchLines = [];
    replaceLines = [];
    currentHeader = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      inHunk = true;
      currentHeader = line;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      flush();
      inHunk = false;
      continue;
    }
    if (line.startsWith('\\') || line === '') continue;
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === ' ') {
      searchLines.push(content);
      replaceLines.push(content);
    } else if (prefix === '-') searchLines.push(content);
    else if (prefix === '+') replaceLines.push(content);
    else {
      searchLines.push(line);
      replaceLines.push(line);
    }
  }
  flush();
  if (blocks.length === 0) throw new Error('No hunks (@@) found in patch.');
  return blocks;
}

function convertUnifiedHunksToSearchReplace(hunks: UnifiedDiffHunk[]): SearchReplaceBlock[] {
  return hunks.map((hunk) => {
    const searchLines: string[] = [];
    const replaceLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        searchLines.push(line.content);
        replaceLines.push(line.content);
      } else if (line.type === 'del') searchLines.push(line.content);
      else replaceLines.push(line.content);
    }
    return { search: searchLines.join('\n'), replace: replaceLines.join('\n'), startLine: Math.max(1, hunk.oldStart), originalHeader: hunk.header };
  });
}

function searchHunkInLines(lines: string[], hunk: UnifiedDiffHunk): number[] {
  const oldLines = hunk.lines.filter((line) => line.type === 'context' || line.type === 'del').map((line) => line.content);
  if (oldLines.length === 0) return [];
  const matches: number[] = [];
  for (let start = 0; start <= lines.length - oldLines.length; start += 1) {
    let ok = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (lines[start + offset] !== oldLines[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(start);
  }
  return matches;
}

function sanitizePatch(patch: string): string {
  return normalizeLineEndings(patch)
    .split('\n')
    .filter((line) => !line.startsWith('```'))
    .filter((line) => !(line === '***' || line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch') || line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** End of File')))
    .join('\n');
}

function parseFileHeaderPath(line: string, prefix: '---' | '+++'): string {
  return line.slice(prefix.length).trim().split('\t')[0]?.trim() || '';
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

function tokenizeLinesWithSpans(text: string): StructuredLineSpan[] {
  const lines: StructuredLineSpan[] = [];
  if (!text) return lines;
  let startIndex = 0;
  let lineNumber = 1;
  while (startIndex < text.length) {
    const newlineIndex = text.indexOf('\n', startIndex);
    if (newlineIndex < 0) {
      lines.push({ content: text.slice(startIndex), newline: '', startIndex, endIndex: text.length, lineNumber });
      break;
    }
    lines.push({ content: text.slice(startIndex, newlineIndex), newline: '\n', startIndex, endIndex: newlineIndex + 1, lineNumber });
    startIndex = newlineIndex + 1;
    lineNumber += 1;
  }
  return lines;
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

function getCharOffsetForLine(content: string, line: number): number | undefined {
  if (!Number.isFinite(line) || line < 1) return undefined;
  if (line === 1) return 0;
  let currentLine = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    currentLine += 1;
    if (currentLine === line) return index + 1;
  }
  return undefined;
}

function getLineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function countTextLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function computeHunkNewLen(hunk: UnifiedDiffHunk): number {
  return hunk.lines.reduce((total, line) => total + (line.type === 'del' ? 0 : 1), 0);
}

function replaceAt(content: string, index: number, length: number, replacement: string): string {
  return `${content.slice(0, index)}${replacement}${content.slice(index + length)}`;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function leadingWhitespace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

function stripLeadingWhitespace(line: string): string {
  return line.slice(leadingWhitespace(line).length);
}
