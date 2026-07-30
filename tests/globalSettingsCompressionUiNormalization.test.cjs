const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { createPinia, setActivePinia } = require('pinia');

const root = path.resolve(__dirname, '..');

function loadGlobalSettingsStoreModule() {
  global.window = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout
  };

  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'webview/src/stores/useGlobalSettingsStore.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    external: ['vue', 'pinia'],
    logLevel: 'silent'
  });

  const filename = path.join(root, '.test-global-settings-store.cjs');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

function compressionConfig(id, thresholdTokens) {
  return {
    id,
    name: `压缩配置 ${id}`,
    kind: 'segmented_summary',
    trigger: {
      mode: 'token_threshold',
      thresholdUnit: 'tokens',
      thresholdTokens,
      thresholdPercent: 80,
      preserveLatestMessages: 8,
      reserveLatestUserMessageTokens: 20_000
    },
    llmSummary: { targetTokens: 2_000 },
    createdAt: 1,
    updatedAt: 1
  };
}

const { useGlobalSettingsStore } = loadGlobalSettingsStoreModule();

test('压缩配置快照归一化不会把数组索引当成上下文窗口 token 上限', () => {
  setActivePinia(createPinia());
  const store = useGlobalSettingsStore();
  const thresholds = [120_000, 220_000, 320_000, 334_000];

  store.applySnapshot({
    section: 'llmCompressionConfigs',
    settings: {
      configs: thresholds.map((thresholdTokens, index) => compressionConfig(`compression-${index}`, thresholdTokens))
    },
    filePath: '/mock/settings/llm-compression-configs/index.json',
    revision: 'compression-revision-1'
  });

  assert.deepEqual(
    store.llmCompressionConfigs.configs.map((config) => config.trigger.thresholdTokens),
    thresholds
  );
});
