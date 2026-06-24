<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolDisplayDiff, ToolDisplayDiffFile } from './types';

type DiffViewMode = 'unified' | 'split';
type ParsedDiffLineKind = 'meta' | 'hunk' | 'context' | 'add' | 'delete';

interface ParsedDiffLine {
  kind: ParsedDiffLineKind;
  raw: string;
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface ParsedDiffFile extends ToolDisplayDiffFile {
  lines: ParsedDiffLine[];
}

const props = defineProps<{
  diff: ToolDisplayDiff;
}>();

const viewMode = ref<DiffViewMode>('unified');
const files = computed<ParsedDiffFile[]>(() =>
  props.diff.files
    .filter((file) => file.text.trim().length > 0)
    .map((file) => ({ ...file, lines: parseUnifiedDiffLines(file.text) }))
);

function setViewMode(mode: DiffViewMode): void {
  viewMode.value = mode;
}

function parseUnifiedDiffLines(diffText: string): ParsedDiffLine[] {
  const lines = diffText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parsed: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      parsed.push({ kind: 'hunk', raw, text: raw });
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('\\')) {
      parsed.push({ kind: 'meta', raw, text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      parsed.push({ kind: 'add', raw, text: raw.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      parsed.push({ kind: 'delete', raw, text: raw.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith(' ')) {
      parsed.push({ kind: 'context', raw, text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    parsed.push({ kind: 'meta', raw, text: raw });
  }

  return parsed;
}
</script>

<template>
  <div class="tool-diff-view">
    <div class="tool-diff-toolbar">
      <span class="tool-diff-summary">{{ diff.summary ?? '文件差异' }}</span>
      <span class="tool-diff-toolbar-spacer" />
      <button
        type="button"
        class="tool-diff-mode-button"
        :class="{ 'is-active': viewMode === 'unified' }"
        :aria-pressed="viewMode === 'unified'"
        @click="setViewMode('unified')"
      >
        Unified
      </button>
      <button
        type="button"
        class="tool-diff-mode-button"
        :class="{ 'is-active': viewMode === 'split' }"
        :aria-pressed="viewMode === 'split'"
        @click="setViewMode('split')"
      >
        分栏
      </button>
    </div>

    <div v-for="file in files" :key="file.path" class="tool-diff-file">
      <div class="tool-diff-file-header">
        <span class="tool-diff-file-path">{{ file.path }}</span>
        <span v-if="file.action" class="tool-diff-file-action">{{ file.action }}</span>
        <span class="tool-diff-file-stat is-add">+{{ file.added ?? 0 }}</span>
        <span class="tool-diff-file-stat is-delete">-{{ file.removed ?? 0 }}</span>
        <span v-if="file.truncated" class="tool-diff-file-truncated">已截断</span>
      </div>

      <div v-if="viewMode === 'unified'" class="tool-diff-lines is-unified">
        <div
          v-for="(line, index) in file.lines"
          :key="`${file.path}-u-${index}`"
          class="tool-diff-line"
          :class="`is-${line.kind}`"
        >
          <span class="tool-diff-line-number">{{ line.oldLine ?? '' }}</span>
          <span class="tool-diff-line-number">{{ line.newLine ?? '' }}</span>
          <code class="tool-diff-line-code">{{ line.raw }}</code>
        </div>
      </div>

      <div v-else class="tool-diff-lines is-split">
        <template v-for="(line, index) in file.lines" :key="`${file.path}-s-${index}`">
          <div v-if="line.kind === 'meta' || line.kind === 'hunk'" class="tool-diff-split-full" :class="`is-${line.kind}`">
            <code>{{ line.raw }}</code>
          </div>
          <div v-else class="tool-diff-split-row" :class="`is-${line.kind}`">
            <span class="tool-diff-line-number">{{ line.oldLine ?? '' }}</span>
            <code class="tool-diff-split-cell is-left">{{ line.kind === 'add' ? '' : line.text }}</code>
            <span class="tool-diff-line-number">{{ line.newLine ?? '' }}</span>
            <code class="tool-diff-split-cell is-right">{{ line.kind === 'delete' ? '' : line.text }}</code>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-diff-view {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-diff-toolbar,
.tool-diff-file-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tool-diff-toolbar {
  padding-bottom: 4px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
}

.tool-diff-summary,
.tool-diff-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-diff-summary {
  color: var(--vscode-foreground);
  font-weight: 600;
}

.tool-diff-toolbar-spacer {
  flex: 1 1 auto;
}

.tool-diff-mode-button {
  min-height: 22px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-sm);
  padding: 0 7px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.tool-diff-mode-button:hover,
.tool-diff-mode-button:focus-visible,
.tool-diff-mode-button.is-active {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.tool-diff-mode-button.is-active {
  border-color: color-mix(in srgb, var(--vscode-foreground) 36%, var(--vscode-panel-border) 64%);
}

.tool-diff-file {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.tool-diff-file-header {
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
}

.tool-diff-file-path {
  flex: 1 1 auto;
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.tool-diff-file-action,
.tool-diff-file-stat,
.tool-diff-file-truncated {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums;
}

.tool-diff-file-stat.is-add {
  color: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
}

.tool-diff-file-stat.is-delete {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c);
}

.tool-diff-lines {
  min-width: max-content;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  line-height: 1.45;
}

.tool-diff-line,
.tool-diff-split-row {
  display: grid;
  min-width: 0;
}

.tool-diff-line {
  grid-template-columns: 4.5ch 4.5ch minmax(32ch, 1fr);
}

.tool-diff-split-row {
  grid-template-columns: 4.5ch minmax(24ch, 1fr) 4.5ch minmax(24ch, 1fr);
}

.tool-diff-line-number {
  padding: 0 6px;
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, transparent);
  text-align: right;
  user-select: none;
}

.tool-diff-line-code,
.tool-diff-split-cell,
.tool-diff-split-full code {
  min-width: 0;
  padding: 0 8px;
  white-space: pre;
  font: inherit;
}

.tool-diff-line-code,
.tool-diff-split-cell.is-left,
.tool-diff-split-cell.is-right {
  border-left: 1px solid color-mix(in srgb, var(--vscode-panel-border) 62%, transparent);
}

.tool-diff-line.is-hunk,
.tool-diff-split-full.is-hunk {
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
}

.tool-diff-line.is-meta,
.tool-diff-split-full.is-meta {
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 82%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.tool-diff-line.is-add,
.tool-diff-split-row.is-add .tool-diff-split-cell.is-right {
  background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 18%, transparent);
  color: var(--vscode-foreground);
}

.tool-diff-line.is-delete,
.tool-diff-split-row.is-delete .tool-diff-split-cell.is-left {
  background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c) 18%, transparent);
  color: var(--vscode-foreground);
}

.tool-diff-split-full {
  display: block;
  padding: 0 8px;
}
</style>
