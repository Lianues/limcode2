import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outfile = path.join(root, 'dist', 'extension', 'vscode', 'extension.js');

mkdirSync(path.dirname(outfile), { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['vscode/extension.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  tsconfig: path.join(root, 'tsconfig.json'),
  external: ['vscode'],
  sourcemap: false,
  sourcesContent: false,
  legalComments: 'none',
  logLevel: 'info'
});
