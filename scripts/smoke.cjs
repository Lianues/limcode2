/* 最终冒烟：开放式 events/effects + world/clientSync + application/bindings + module clientSync 命名收口 */
const path = require('path');
const base = path.join(__dirname, '..', 'dist', 'extension', 'backend');
const { MapWorld } = require(path.join(base, 'ecs', 'World.js'));
const { Scheduler } = require(path.join(base, 'ecs', 'Scheduler.js'));
const { EffectOutbox } = require(path.join(base, 'world', 'effects.js'));
const { installWorldPlugins } = require(path.join(base, 'world', 'plugin.js'));
const { commonPlugin, agentPlugin, chatPlugin, createToolRegistry, requestSpawnAgent, toolsPlugin } = require(path.join(base, 'world', 'modules', 'index.js'));
const { clientSyncPlugin } = require(path.join(base, 'world', 'clientSync', 'index.js'));
const { ChatEventType } = require(path.join(base, 'world', 'modules', 'chat', 'events.js'));
const { Session } = require(path.join(base, 'world', 'modules', 'chat', 'components.js'));
const { createFakeLlmCapability } = require(path.join(base, 'capabilities', 'fakeLlm.js'));
const { EffectHandlerRegistry, registerApplicationBindings } = require(path.join(base, 'application', 'bindings', 'index.js'));
const { flushEffects } = require(path.join(base, 'application', 'executeEffects.js'));

const world = new MapWorld();
const outbox = new EffectOutbox();
const registry = createToolRegistry();
const handlers = new EffectHandlerRegistry();
registerApplicationBindings(handlers);

let snapshots = 0;
let patches = 0;
let lastState = null;

const env = {
  llm: createFakeLlmCapability(),
  fs: { readFile: async (p) => `Hello from ${p}\nsecond line\nthird line` },
  webview: {
    attach() {},
    detach() {},
    post(message) {
      if (message.type === 'client:snapshot') {
        snapshots += 1;
        lastState = message.payload.state;
      }
      if (message.type === 'client:patch') {
        patches += 1;
      }
    }
  },
  tools: { registry: registry.list() }
};

const scheduler = new Scheduler(world, { afterTick: () => flushEffects(outbox, env, (event) => world.enqueue(event), handlers) });
installWorldPlugins(
  { world, scheduler, outbox },
  [commonPlugin(), clientSyncPlugin(), agentPlugin(), toolsPlugin({ toolSchemas: registry.schemas() }), chatPlugin()]
);

requestSpawnAgent(world, { kind: 'main', agentId: 'test-agent', sessionId: 'default' });
world.enqueue({ type: 'client:resync', payload: { sessionId: 'default' } });
setTimeout(() => world.enqueue({ type: ChatEventType.Send, payload: { sessionId: 'default', text: '/read foo.ts' } }), 20);
setTimeout(() => world.enqueue({ type: 'client:resync', payload: { sessionId: 'default' } }), 1500);
setTimeout(() => {
  const sessions = world.query(Session);
  console.log(`sessions=${sessions.length} snapshots=${snapshots} patches=${patches}`);
  console.log(`stateSlices=${Object.keys(lastState ?? {}).join(',')}`);
  if (lastState) {
    console.log(`agents=${lastState.agents.length} sessions=${lastState.sessions.length} messages=${lastState.messages.length} toolCalls=${lastState.toolCalls.length}`);
  }
}, 2200);
