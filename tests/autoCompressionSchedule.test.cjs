const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Scheduler } = require('../dist/extension/backend/ecs/Scheduler.js');
const { AutoCompressionSystem } = require('../dist/extension/backend/world/modules/compression/systems/AutoCompressionSystem.js');
const { CompressionSystem } = require('../dist/extension/backend/world/modules/compression/systems/CompressionSystem.js');
const { ToolDispatchSystem } = require('../dist/extension/backend/world/modules/tools/systems/ToolDispatchSystem.js');
const { ToolResultSystem } = require('../dist/extension/backend/world/modules/tools/systems/ToolResultSystem.js');
const { ContextAssemblySystem } = require('../dist/extension/backend/world/modules/chat/systems/ContextAssemblySystem.js');
const { LlmDispatchSystem } = require('../dist/extension/backend/world/modules/chat/systems/LlmDispatchSystem.js');

test('ToolResult 提交后 AutoCompression 在 ContextAssembly/LlmDispatch 前运行且调度图无环', () => {
  const world = new MapWorld();
  const scheduler = new Scheduler(world);
  // 按真实插件注册的相对顺序：CompressionSystem 提前；tools 完成后安装 AutoCompression；最后是 chat。
  scheduler.addMany([
    CompressionSystem,
    ToolDispatchSystem,
    ToolResultSystem,
    AutoCompressionSystem,
    ContextAssemblySystem,
    LlmDispatchSystem
  ]);

  const order = scheduler.getSystemOrder();
  assert.ok(order.indexOf('ToolResultSystem') < order.indexOf('AutoCompressionSystem'));
  assert.ok(order.indexOf('AutoCompressionSystem') < order.indexOf('ContextAssemblySystem'));
  assert.ok(order.indexOf('AutoCompressionSystem') < order.indexOf('LlmDispatchSystem'));
  scheduler.dispose();
});
