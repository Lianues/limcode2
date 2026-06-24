import { WRITE_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface WriteArgs {
  path?: string;
  content?: string;
}

export const writeToolModule = defineToolDefinitionModule({
  id: WRITE_TOOL_NAME,
  create() {
    return writeTool;
  }
});

export const writeTool: ToolDefinition = {
  declaration: {
    name: WRITE_TOOL_NAME,
    description: [
      'Write a UTF-8 text file in the current work environment.',
      'Creates parent directories automatically when the file does not exist.',
      'Returns unchanged when the target content is identical to the existing file.',
      'Use edit for small targeted replacements; use write when you intentionally provide the complete file content.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root.' },
        content: { type: 'string', description: 'Complete UTF-8 content to write to the file.' }
      },
      required: ['path', 'content']
    },
    metadata: {
      category: 'filesystem',
      riskLevel: 'write',
      readonly: false,
      defaultEnabled: true,
      requiresApproval: true,
      checkpoint: { before: true, after: true }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'filesystem_write_side_effect'),
  summary: summarizeWriteToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as WriteArgs;
    if (!args.path) return { ok: false, output: 'Missing required argument: path' };
    if (typeof args.content !== 'string') return { ok: false, output: 'Missing required argument: content' };
    const result = await deps.fs.writeFile(args.path, args.content, { workEnvironment: ctx?.workEnvironment });
    return { ok: result.success, output: result };
  }
};

function summarizeWriteToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as WriteArgs;
  const path = normalizeDisplayPath(args.path);
  return path ? `write ${path}` : undefined;
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}
