import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(root, 'tests');
const testFiles = (await readdir(testsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.cjs'))
  .map((entry) => path.join('tests', entry.name))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  throw new Error(`未找到 Node 测试文件：${testsRoot}`);
}

const child = spawn(process.execPath, ['--test', ...testFiles], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error('[LimCode] 无法启动 Node 测试：', error);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[LimCode] Node 测试被信号终止：${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
