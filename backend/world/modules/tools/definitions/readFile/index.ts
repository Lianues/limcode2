import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface ReadFileArgs {
  path?: string;
  startLine?: number;
  endLine?: number;
}

export const readFileToolModule = defineToolDefinitionModule({
  id: 'read_file',
  create() {
    return readFileTool;
  }
});

export const readFileTool: ToolDefinition = {
  declaration: {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Optional startLine/endLine are 1-based and inclusive.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        startLine: { type: 'number', description: '1-based start line (inclusive).' },
        endLine: { type: 'number', description: '1-based end line (inclusive).' }
      },
      required: ['path']
    },
    metadata: {
      category: 'filesystem',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_file_read'),
  async execute(rawArgs, deps) {
    const args = (rawArgs ?? {}) as ReadFileArgs;
    if (!args.path) {
      return { ok: false, output: 'Missing required argument: path' };
    }
    const text = await deps.fs.readFile(args.path, args.startLine, args.endLine);
    return { ok: true, output: text };
  }
};
