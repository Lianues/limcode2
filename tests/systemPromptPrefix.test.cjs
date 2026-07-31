const assert = require('node:assert/strict');
const test = require('node:test');
const {
  composeSystemInstruction,
  prependSystemPromptPrefix
} = require('../dist/extension/backend/world/modules/chat/systems/LlmDispatchSystem.js');

const integratedPrompt = composeSystemInstruction([{
  id: 'system-prompt:global:integrated',
  name: 'Integrated Global System Prompt',
  text: 'You are LimCode Agent.'
}]);

test('Integrated Global System Prompt 不再输出标题', () => {
  const result = composeSystemInstruction([
    { id: 'system-prompt:global:integrated', name: 'Integrated Global System Prompt', text: 'You are LimCode Agent.' },
    { name: 'Main Agent System Prompt', text: 'Follow the active workflow.' }
  ]);

  assert.equal(
    result,
    'You are LimCode Agent.\n\n[Main Agent System Prompt]\nFollow the active workflow.'
  );
  assert.equal(result.includes('[Integrated Global System Prompt]'), false);
});

test('空前置系统提示词保持现有系统提示词不变', () => {
  assert.equal(prependSystemPromptPrefix(integratedPrompt, ''), integratedPrompt);
  assert.equal(prependSystemPromptPrefix(integratedPrompt, '  \n  '), integratedPrompt);
});

test('前置系统提示词不添加标签并与内置正文空一行', () => {
  const result = prependSystemPromptPrefix(integratedPrompt, '\n请始终使用中文回答。\n\n');

  assert.equal(
    result,
    '请始终使用中文回答。\n\nYou are LimCode Agent.'
  );
  assert.equal(result.includes('[前置系统提示词]'), false);
  assert.equal(result.includes('[Integrated Global System Prompt]'), false);
});

test('现有系统提示词为空时仅使用前置内容', () => {
  assert.equal(prependSystemPromptPrefix('  ', '模型原生系统指令'), '模型原生系统指令');
});
