const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments)); }
  toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
}

let workspaceFsCalls = 0;
const vscodeMock = {
  Uri: MockUri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    fs: {
      createDirectory: async () => { workspaceFsCalls += 1; throw new Error('Canceled'); },
      readDirectory: async () => { workspaceFsCalls += 1; throw new Error('Canceled'); },
      delete: async () => { workspaceFsCalls += 1; throw new Error('Canceled'); },
      readFile: async () => { workspaceFsCalls += 1; throw new Error('Canceled'); },
      writeFile: async () => { workspaceFsCalls += 1; throw new Error('Canceled'); }
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const recordStore = require('../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');

test('file URI record store 在 workspace.fs 被 Canceled 时仍使用 Node fs 完成保存', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-storage-fs-shutdown-'));
  const root = MockUri.file(path.join(tempRoot, 'records-store'));
  const indexUri = MockUri.joinPath(root, 'index.json');
  workspaceFsCalls = 0;
  try {
    await recordStore.saveRecordStore(root, indexUri, [{ id: 'record-1', value: 'saved' }], 'record');
    const loaded = await recordStore.loadRecordStore(root, indexUri, 'record');
    assert.deepEqual(loaded, [{ id: 'record-1', value: 'saved' }]);
    assert.equal(workspaceFsCalls, 0, 'local business storage must not call cancellable workspace.fs');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('收尾恢复 vscode mock', () => {
  Module._load = originalLoad;
});
