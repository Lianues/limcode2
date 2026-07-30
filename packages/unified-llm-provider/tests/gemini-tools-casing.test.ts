import { describe, expect, it } from 'vitest';

import { convertRequest } from '../src/index.js';

describe('Gemini tools casing normalization', () => {
  const geminiLikeRaw = {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools: [{
      function_declarations: [{
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string' },
          },
          required: ['city'],
        },
      }],
    }],
  };

  it('gemini -> claude 时会把 function_declarations 归一化为 functionDeclarations', () => {
    const converted = convertRequest(geminiLikeRaw, {
      from: 'gemini',
      to: 'claude',
      model: 'claude-sonnet-4',
    }) as any;

    expect(converted.tools).toHaveLength(1);
    expect(converted.tools[0].name).toBe('get_weather');
    expect(converted.tools[0].description).toBe('Get weather');
  });

  it('gemini -> openai-compatible 时不会因 flatMap([undefined]) 崩溃', () => {
    const converted = convertRequest(geminiLikeRaw, {
      from: 'gemini',
      to: 'openai-compatible',
      model: 'gpt-4o',
    }) as any;

    expect(converted.tools).toHaveLength(1);
    expect(converted.tools[0].function.name).toBe('get_weather');
  });
});
