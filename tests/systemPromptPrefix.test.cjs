const assert = require('node:assert/strict');
const test = require('node:test');
const {
  prependSystemPromptPrefix
} = require('../dist/extension/backend/world/modules/chat/systems/LlmDispatchSystem.js');

const integratedPrompt = '[Integrated Global System Prompt]\nYou are LimCode Agent.';

test('空前置系统提示词保持现有系统提示词不变', () => {
  assert.equal(prependSystemPromptPrefix(integratedPrompt, ''), integratedPrompt);
  assert.equal(prependSystemPromptPrefix(integratedPrompt, '  \n  '), integratedPrompt);
});

test('前置系统提示词不添加标签并以单个换行连接 Integrated Global System Prompt', () => {
  const result = prependSystemPromptPrefix(integratedPrompt, '\n请始终使用中文回答。\n\n');

  assert.equal(
    result,
    '请始终使用中文回答。\n[Integrated Global System Prompt]\nYou are LimCode Agent.'
  );
  assert.equal(result.includes('[前置系统提示词]'), false);
});

test('现有系统提示词为空时仅使用前置内容', () => {
  assert.equal(prependSystemPromptPrefix('  ', '模型原生系统指令'), '模型原生系统指令');
});
