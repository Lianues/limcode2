const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { createRenderer, defineComponent, h, nextTick, ref } = require('vue');

const root = path.resolve(__dirname, '..');

function loadBottomStickyScrollerModule() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'webview/src/composables/useBottomStickyScroller.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    external: ['vue'],
    logLevel: 'silent'
  });

  const filename = path.join(root, '.test-bottom-sticky-scroller.cjs');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

class FakeElement {
  constructor() {
    this.scrollTop = 500;
    this.scrollHeight = 1_000;
    this.clientHeight = 500;
    this.firstElementChild = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  closest() {
    return null;
  }
}

function createNoopRenderer() {
  return createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement() { return {}; },
    createText() { return {}; },
    createComment() { return {}; },
    setText() {},
    setElementText() {},
    parentNode() { return null; },
    nextSibling() { return null; }
  });
}

test('内容检查和 sticky settle 始终合并到同一个 animation frame', async () => {
  const frameCallbacks = new Map();
  let nextFrameId = 1;
  const resizeObservers = [];
  const mutationObservers = [];

  global.Element = FakeElement;
  global.HTMLElement = FakeElement;
  global.window = {
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frameCallbacks.delete(id);
    }
  };
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }
    observe() {}
    disconnect() {}
  };

  const { useBottomStickyScroller } = loadBottomStickyScrollerModule();
  const scroller = new FakeElement();
  scroller.firstElementChild = new FakeElement();
  const renderer = createNoopRenderer();
  const App = defineComponent({
    setup() {
      useBottomStickyScroller(ref(scroller), { settleMs: 500 });
      return () => h('div');
    }
  });
  const app = renderer.createApp(App);
  app.mount({});
  await nextTick();

  assert.equal(frameCallbacks.size, 1);
  assert.equal(resizeObservers.length, 1);
  assert.equal(mutationObservers.length, 1);

  resizeObservers[0].callback([]);
  mutationObservers[0].callback([]);
  resizeObservers[0].callback([]);
  assert.equal(frameCallbacks.size, 1);

  const [frameId, frame] = frameCallbacks.entries().next().value;
  frameCallbacks.delete(frameId);
  frame(performance.now());
  assert.equal(frameCallbacks.size, 1);

  mutationObservers[0].callback([]);
  resizeObservers[0].callback([]);
  assert.equal(frameCallbacks.size, 1);

  app.unmount();
  assert.equal(frameCallbacks.size, 0);
});
