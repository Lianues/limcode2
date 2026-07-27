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
    this.path = this.fsPath.replace(/\\/g, '/');
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  static from(input) {
    return new MockUri(input.path || '/');
  }

  toString() {
    return `file://${this.fsPath.replace(/\\/g, '/')}`;
  }
}

function installVscodeMock() {
  const mock = {
    Uri: MockUri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      workspaceFolders: [],
      fs: {
        createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
          .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
        delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: false }),
        readFile: (uri) => fs.readFile(uri.fsPath),
        writeFile: async (uri, data) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, data);
        }
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} })
    },
    commands: { executeCommand: async () => undefined },
    window: {
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return mock;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = originalLoad; };
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTempRoot(target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      await delay(25 * attempt);
    }
  }
}

/** 递归读取目录下所有非锁文件的原始内容，用于断言“冲突时盘上数据逐字节不变”。 */
async function readTree(root) {
  const snapshot = new Map();
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (relative.endsWith('.lock') || relative.endsWith('.tmp')) continue;
      snapshot.set(relative, await fs.readFile(absolute, 'utf8'));
    }
  }
  await walk(root, '');
  return snapshot;
}

const restore = installVscodeMock();
process.on('exit', restore);

const {
  loadLlmProviderConfigsSettings,
  saveLlmProviderConfigsSettings,
  createDefaultLlmProviderConfig
} = require('../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const {
  loadGlobalSettingsFile,
  writeGlobalSettingsFile
} = require('../dist/extension/backend/capabilities/vscodeStorage/globalSettings.js');
const { isSettingsRevisionConflictError } = require('../dist/extension/backend/capabilities/settingsRevisionConflict.js');
const { GLOBAL_SETTINGS_WATCH_PATTERNS } = require('../dist/extension/vscode/watchers/GlobalSettingsWatcher.js');

function createPaths(tempRoot) {
  return { settingsRootUri: MockUri.file(path.join(tempRoot, 'settings')) };
}

function configWithName(name) {
  return { ...createDefaultLlmProviderConfig({ name }), name };
}

test('携带匹配 revision 的保存成功，并推进到新的 revision', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-revision-ok-'));
  try {
    const paths = createPaths(tempRoot);
    const initial = await loadLlmProviderConfigsSettings(paths);
    assert.equal(typeof initial.revision, 'string');
    assert.equal(initial.settings.configs.length, 1);

    await delay(5);
    const nextConfigs = [...initial.settings.configs, configWithName('P1')];
    const saved = await saveLlmProviderConfigsSettings(paths, { configs: nextConfigs }, initial.revision);

    assert.equal(saved.settings.configs.length, 2);
    assert.equal(typeof saved.revision, 'string');
    assert.notEqual(saved.revision, initial.revision);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('携带过期 revision 的保存被拒绝，且盘上数据逐字节不变', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-revision-stale-'));
  try {
    const paths = createPaths(tempRoot);
    const configsRoot = path.join(tempRoot, 'settings', 'llm-provider-configs');
    const initial = await loadLlmProviderConfigsSettings(paths);
    const staleRevision = initial.revision;

    await delay(5);
    await saveLlmProviderConfigsSettings(paths, { configs: [...initial.settings.configs, configWithName('P1')] }, staleRevision);

    const before = await readTree(configsRoot);
    await delay(5);

    // 陈旧快照：只有 P0，没有 P1。旧实现会把 P1 直接删掉。
    await assert.rejects(
      () => saveLlmProviderConfigsSettings(paths, { configs: [...initial.settings.configs, configWithName('P2')] }, staleRevision),
      (error) => {
        assert.ok(isSettingsRevisionConflictError(error), `expected revision conflict, got: ${error}`);
        assert.equal(error.section, 'llmProviderConfigs');
        return true;
      }
    );

    const after = await readTree(configsRoot);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, content] of before) {
      assert.equal(after.get(file), content, `冲突后文件被改动：${file}`);
    }
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('复现原 bug：B 窗口持旧 revision 提交时 A 窗口新增的渠道必须存活', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-revision-repro-'));
  try {
    const paths = createPaths(tempRoot);
    // 两个窗口都读到同一份初始快照 [P0]。
    const windowA = await loadLlmProviderConfigsSettings(paths);
    const windowB = await loadLlmProviderConfigsSettings(paths);
    assert.equal(windowA.revision, windowB.revision);

    await delay(5);
    // A 窗口先保存 [P0, P1]。
    await saveLlmProviderConfigsSettings(paths, { configs: [...windowA.settings.configs, configWithName('P1')] }, windowA.revision);

    await delay(5);
    // B 窗口基于陈旧快照提交 [P0, P2]。
    await assert.rejects(
      () => saveLlmProviderConfigsSettings(paths, { configs: [...windowB.settings.configs, configWithName('P2')] }, windowB.revision),
      (error) => isSettingsRevisionConflictError(error)
    );

    const current = await loadLlmProviderConfigsSettings(paths);
    const names = current.settings.configs.map((config) => config.name).sort();
    assert.deepEqual(names, ['P1', '默认渠道']);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('不传 expectedRevision 时完全保持旧行为（不校验、允许全量覆盖）', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-revision-legacy-'));
  try {
    const paths = createPaths(tempRoot);
    const initial = await loadLlmProviderConfigsSettings(paths);

    await delay(5);
    await saveLlmProviderConfigsSettings(paths, { configs: [...initial.settings.configs, configWithName('P1')] });

    await delay(5);
    // 旧行为：陈旧列表照样落盘，P1 被移除。这是本方案刻意保留的兼容路径。
    const saved = await saveLlmProviderConfigsSettings(paths, { configs: initial.settings.configs });
    assert.deepEqual(saved.settings.configs.map((config) => config.name), ['默认渠道']);

    const reloaded = await loadLlmProviderConfigsSettings(paths);
    assert.deepEqual(reloaded.settings.configs.map((config) => config.name), ['默认渠道']);
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('文件型 section 同样支持 revision 校验且冲突时不覆盖', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-revision-file-'));
  try {
    const settingsRoot = MockUri.file(path.join(tempRoot, 'settings'));
    const initial = await loadGlobalSettingsFile(settingsRoot, 'attachments');
    assert.equal(typeof initial.revision, 'string');

    await delay(5);
    await writeGlobalSettingsFile(settingsRoot, 'attachments', { maxStoredInlineFileMb: 40 }, initial.revision);
    const afterFirst = await loadGlobalSettingsFile(settingsRoot, 'attachments');
    assert.deepEqual(afterFirst.settings, { maxStoredInlineFileMb: 40 });
    assert.notEqual(afterFirst.revision, initial.revision);

    await delay(5);
    await assert.rejects(
      () => writeGlobalSettingsFile(settingsRoot, 'attachments', { maxStoredInlineFileMb: 99 }, initial.revision),
      (error) => {
        assert.ok(isSettingsRevisionConflictError(error), `expected revision conflict, got: ${error}`);
        assert.equal(error.section, 'attachments');
        return true;
      }
    );

    const afterConflict = await loadGlobalSettingsFile(settingsRoot, 'attachments');
    assert.deepEqual(afterConflict.settings, { maxStoredInlineFileMb: 40 });
    assert.equal(afterConflict.revision, afterFirst.revision);

    // 不传 expectedRevision 仍然直接覆盖。
    await delay(5);
    await writeGlobalSettingsFile(settingsRoot, 'attachments', { maxStoredInlineFileMb: 99 });
    assert.deepEqual((await loadGlobalSettingsFile(settingsRoot, 'attachments')).settings, { maxStoredInlineFileMb: 99 });
  } finally {
    await removeTempRoot(tempRoot);
  }
});

test('settings watcher 白名单精确到具体文件，不会匹配高频的 conversation-*-llm.json', () => {
  assert.ok(Array.isArray(GLOBAL_SETTINGS_WATCH_PATTERNS));
  assert.ok(GLOBAL_SETTINGS_WATCH_PATTERNS.length > 0);

  for (const pattern of GLOBAL_SETTINGS_WATCH_PATTERNS) {
    assert.ok(pattern.startsWith('settings/'), `watch 模式必须限定在 settings/ 下：${pattern}`);
    assert.equal(pattern.includes('conversation-'), false, `watch 模式不得覆盖会话级设置：${pattern}`);
    // 顶层 settings 目录只允许花括号白名单，绝不允许 settings/*.json 这种通配。
    if (!pattern.includes('/', 'settings/'.length)) {
      assert.ok(pattern.includes('{'), `顶层 settings 文件必须逐个白名单列举：${pattern}`);
      assert.equal(pattern.includes('*'), false, `顶层 settings 文件不得使用通配：${pattern}`);
    }
  }

  const globalFiles = GLOBAL_SETTINGS_WATCH_PATTERNS.find((pattern) => pattern.includes('{'));
  assert.ok(globalFiles, '缺少顶层设置文件白名单');
  for (const expected of ['llm', 'llm-compression', 'appearance', 'attachments', 'checkpoint-maintenance', 'run-history']) {
    assert.ok(globalFiles.includes(expected), `白名单缺少 ${expected}.json`);
  }

  assert.ok(GLOBAL_SETTINGS_WATCH_PATTERNS.some((pattern) => pattern.startsWith('settings/llm-provider-configs/')));
  assert.ok(GLOBAL_SETTINGS_WATCH_PATTERNS.some((pattern) => pattern.startsWith('settings/mcp-servers/')));
  assert.ok(GLOBAL_SETTINGS_WATCH_PATTERNS.some((pattern) => pattern.startsWith('settings/llm-compression-configs/')));
});
