const assert = require('node:assert/strict');
const test = require('node:test');
const {
  dryRunLlmProvider,
  installGeminiOpenAICompatibleThoughtSignatures
} = require('../dist/extension/backend/capabilities/llmProvider.js');

function providerConfig(overrides = {}) {
  return {
    id: 'provider-test',
    name: 'Provider Test',
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
    apiKey: 'sk-test',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function chatRequest(id = 'gemini-compatibility') {
  return {
    id,
    invocationId: `invocation-${id}`,
    conversationId: 'conversation-gemini-compatibility',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools: []
  };
}

test('OpenAI-compatible Gemini 3 round-trips Google and Vertex thought signatures', async () => {
  const unified = await import('unified-llm-provider');
  const provider = installGeminiOpenAICompatibleThoughtSignatures({
    format: new unified.OpenAICompatibleFormat('firebase/gemini-3.7-flash')
  }, 'openai-compatible', 'firebase/gemini-3.7-flash');

  const signed = provider.format.encodeRequest({
    contents: [{
      role: 'model',
      parts: [
        {
          functionCall: { name: 'update_task_list', args: {}, callId: 'call-signed' },
          thoughtSignatures: { gemini: 'real-signature' }
        },
        { functionCall: { name: 'read', args: {}, callId: 'call-signed-parallel' } }
      ]
    }]
  }, false);
  assert.equal(signed.messages[0].tool_calls[0].extra_content.google.thought_signature, 'real-signature');
  assert.equal(signed.messages[0].tool_calls[0].extra_content.google.thoughtSignature, 'real-signature');
  assert.equal(signed.messages[0].tool_calls[1].extra_content, undefined);

  const transferred = provider.format.encodeRequest({
    contents: [{
      role: 'model',
      parts: [
        { functionCall: { name: 'update_task_list', args: {}, callId: 'call-transferred' } },
        { functionCall: { name: 'read', args: {}, callId: 'call-parallel' } }
      ]
    }]
  }, false);
  assert.equal(
    transferred.messages[0].tool_calls[0].extra_content.google.thought_signature,
    'skip_thought_signature_validator'
  );
  assert.equal(
    transferred.messages[0].tool_calls[1].extra_content.google.thoughtSignature,
    'skip_thought_signature_validator'
  );

  const decoded = provider.format.decodeResponse({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call-google',
            type: 'function',
            function: { name: 'update_task_list', arguments: '{}' },
            extra_content: { google: { thoughtSignature: 'google-signature' } }
          },
          {
            id: 'call-vertex',
            type: 'function',
            function: { name: 'read', arguments: '{}' },
            extra_content: { vertex: { thought_signature: 'vertex-signature' } }
          }
        ]
      },
      finish_reason: 'tool_calls'
    }]
  });
  assert.equal(decoded.content.parts[0].thoughtSignatures.gemini, 'google-signature');
  assert.equal(decoded.content.parts[1].thoughtSignatures.gemini, 'vertex-signature');

  const streamState = provider.format.createStreamState();
  const chunk = provider.format.decodeStreamChunk({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-stream',
          type: 'function',
          function: { name: 'update_task_list', arguments: '{}' },
          extra_content: { google: { thought_signature: 'stream-signature' } }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  }, streamState);
  const streamedCall = [...(chunk.functionCalls ?? []), ...(chunk.partsDelta ?? [])]
    .find((part) => part.functionCall?.callId === 'call-stream');
  assert.equal(streamedCall.thoughtSignatures.gemini, 'stream-signature');
});

test('OpenAI-compatible non-Gemini models are not modified', async () => {
  const unified = await import('unified-llm-provider');
  const provider = installGeminiOpenAICompatibleThoughtSignatures({
    format: new unified.OpenAICompatibleFormat('gpt-test')
  }, 'openai-compatible', 'gpt-test');
  const encoded = provider.format.encodeRequest({
    contents: [{
      role: 'model',
      parts: [{ functionCall: { name: 'read', args: {}, callId: 'call-gpt' } }]
    }]
  }, false);
  assert.equal(encoded.messages[0].tool_calls[0].extra_content, undefined);
});

test('OpenAI-compatible Gemini 3 dry-run fills transferred history signatures', async () => {
  const request = chatRequest('gemini-openai-compatible-signature');
  request.contents = [
    {
      role: 'model',
      parts: [{ id: 'call-transferred', functionCall: { name: 'update_task_list', args: {} } }]
    },
    {
      role: 'user',
      parts: [{
        id: 'call-transferred',
        functionResponse: { name: 'update_task_list', response: { ok: true } }
      }]
    }
  ];
  const result = await dryRunLlmProvider(request, {
    settings: providerConfig({
      model: 'firebase/gemini-3.7-flash',
      models: []
    })
  });
  assert.equal(
    result.body.messages[0].tool_calls[0].extra_content.google.thought_signature,
    'skip_thought_signature_validator'
  );
  assert.equal(
    result.body.messages[0].tool_calls[0].extra_content.google.thoughtSignature,
    'skip_thought_signature_validator'
  );
});

test('native Gemini merges split parallel function responses only at its provider boundary', async () => {
  const request = chatRequest('gemini-parallel-tool-responses');
  request.contents = [
    {
      role: 'model',
      parts: [
        {
          id: 'call-read-a',
          functionCall: { name: 'read', args: { path: 'a.txt' } },
          thoughtSignature: 'gemini:parallel-signature'
        },
        { id: 'call-read-b', functionCall: { name: 'read', args: { path: 'b.txt' } } }
      ]
    },
    {
      role: 'user',
      parts: [{ id: 'call-read-a', functionResponse: { name: 'read', response: { ok: true } } }]
    },
    {
      role: 'user',
      parts: [{ id: 'call-read-b', functionResponse: { name: 'read', response: { ok: true } } }]
    },
    { role: 'user', parts: [{ text: 'continue' }] }
  ];

  const gemini = await dryRunLlmProvider(request, {
    settings: providerConfig({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.7-flash'
    })
  });
  assert.equal(gemini.body.contents.length, 3);
  assert.deepEqual(
    gemini.body.contents[1].parts.map((part) => part.functionResponse?.id),
    ['call-read-a', 'call-read-b']
  );
  assert.equal(gemini.body.contents[2].parts[0].text, 'continue');

  const claude = await dryRunLlmProvider(request, {
    settings: providerConfig({
      provider: 'claude',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test'
    })
  });
  assert.equal(claude.body.messages.length, 4);
  assert.equal(claude.body.messages[1].content.length, 1);
  assert.equal(claude.body.messages[2].content.length, 1);
});

test('native Gemini removes propertyNames and multipleOf without changing other providers', async () => {
  const request = chatRequest('gemini-schema');
  request.tools = [{
    name: 'integer_value',
    description: 'Checks nested numeric schema compatibility.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            value: {
              type: 'object',
              propertyNames: { type: 'string' },
              properties: {
                score: { type: 'number', minimum: 0, maximum: 100, multipleOf: 1 }
              }
            }
          },
          required: ['title']
        }
      }
    }
  }];

  const gemini = await dryRunLlmProvider(request, {
    settings: providerConfig({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.7-flash'
    })
  });
  assert.doesNotMatch(gemini.bodyText, /propertyNames|multipleOf/i);
  assert.match(gemini.bodyText, /"minimum":\s*0/);
  assert.match(gemini.bodyText, /"maximum":\s*100/);
  const declaration = gemini.body.tools[0].functionDeclarations[0];
  assert.equal(declaration.parameters.properties.options.properties.title.type, 'string');
  assert.deepEqual(declaration.parameters.properties.options.required, ['title']);

  const openaiCompatible = await dryRunLlmProvider(request, {
    settings: providerConfig()
  });
  assert.match(openaiCompatible.bodyText, /propertyNames/);
  assert.match(openaiCompatible.bodyText, /multipleOf/);
});
