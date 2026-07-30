import { describe, expect, it } from 'vitest';

import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/index.js';

describe('format bridge', () => {
  it('可把 unified request 转成 Claude request，签名随请求体格式一起落位', () => {
    const raw = convertRequest({
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'deep thought', thought: true, thoughtSignature: 'claude:sig_req_1' }] },
      ],
    }, {
      from: 'unified',
      to: 'claude',
      model: 'claude-sonnet-4',
    }) as any;

    const thinking = raw.messages[1].content.find((block: any) => block.type === 'thinking');
    expect(thinking.signature).toBe('sig_req_1');
    expect(thinking.thinking).toBe('deep thought');
  });

  it('可把 Claude response 转回 unified，自动补 thoughtSignature 前缀', () => {
    const raw = convertResponse({
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig_resp_1' },
        { type: 'text', text: 'done' },
      ],
      stop_reason: 'end_turn',
    }, {
      from: 'claude',
      to: 'unified',
      model: 'claude-sonnet-4',
    }) as any;

    expect(raw.content.parts[0].thoughtSignature).toBe('claude:sig_resp_1');
    expect(raw.content.parts[0].thoughtSignatures).toBeUndefined();
  });

  it('可把 OpenAI Responses request 转成 unified request，并保留 openai 签名', () => {
    const raw = convertRequest({
      model: 'o3',
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }], encrypted_content: 'enc_sig_1' },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    }, {
      from: 'openai-responses',
      to: 'unified',
      model: 'o3',
    }) as any;

    expect(raw.contents[0].parts[0].thoughtSignature).toBe('openai-responses:enc_sig_1');
  });

  it('base64 文件可在 Claude 与 unified 之间互转，不按 MIME 做图片判断', () => {
    const unified = {
      contents: [{
        role: 'user',
        parts: [
          { text: '请读取文件' },
          { inlineData: { mimeType: 'image/jpeg', data: 'aW1n', name: 'image.jpg' } },
        ],
      }],
    };

    const claude = convertRequest(unified, {
      from: 'unified',
      to: 'claude',
      model: 'claude-sonnet-4',
    }) as any;

    const documentBlock = claude.messages[0].content.find((block: any) => block.type === 'document');
    expect(documentBlock).toMatchObject({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'aW1n',
      },
    });
    expect(documentBlock.title).toBeUndefined();

    const roundTrip = convertRequest(claude, {
      from: 'claude',
      to: 'unified',
      model: 'claude-sonnet-4',
    }) as any;

    expect(roundTrip.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: 'aW1n',
    });
  });

  it('OpenAI-compatible 发送图片 image_url 和文档 file，并过滤其它 inlineData', () => {
    const unified = {
      contents: [{
        role: 'user',
        parts: [
          { text: '请读取附件' },
          { inlineData: { mimeType: 'image/jpeg', data: 'aW1n', name: 'image.jpg' } },
          { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=', name: 'paper.pdf' } },
          { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==', name: 'voice.wav' } },
        ],
      }],
    };

    const openai = convertRequest(unified, {
      from: 'unified',
      to: 'openai-compatible',
      model: 'gpt-4o',
    }) as any;

    const content = openai.messages[0].content;
    expect(content).toEqual([
      { type: 'text', text: '请读取附件' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,aW1n' },
      },
      {
        type: 'file',
        file: { file_data: 'data:application/pdf;base64,JVBERi0=' },
      },
    ]);

    const roundTrip = convertRequest(openai, {
      from: 'openai-compatible',
      to: 'unified',
      model: 'gpt-4o',
    }) as any;

    expect(roundTrip.contents[0].parts).toHaveLength(3);
    expect(roundTrip.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: 'aW1n',
    });
    expect(roundTrip.contents[0].parts[2].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: 'JVBERi0=',
    });
  });

  it('图片可在 OpenAI Responses 与 unified 之间按 input_image 互转', () => {
    const unified = {
      contents: [{
        role: 'user',
        parts: [
          { text: '请读取附件' },
          { inlineData: { mimeType: 'image/jpeg', data: 'aW1n', name: 'image.jpg' } },
        ],
      }],
    };

    const responses = convertRequest(unified, {
      from: 'unified',
      to: 'openai-responses',
      model: 'o3',
    }) as any;

    const content = responses.input[0].content;
    expect(content[1]).toEqual({
      type: 'input_image',
      detail: 'auto',
      image_url: 'data:image/jpeg;base64,aW1n',
    });

    const roundTrip = convertRequest(responses, {
      from: 'openai-responses',
      to: 'unified',
      model: 'o3',
    }) as any;

    expect(roundTrip.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/jpeg',
      data: 'aW1n',
    });
  });


  it('工具响应多模态在 Claude 中仅保留图片/文档', () => {
    const raw = convertRequest({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {}, callId: 'toolu_1' } }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'get_weather',
              callId: 'toolu_1',
              response: { temperature: '15 degrees' },
              parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'aW1n' } },
                { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
                { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } },
              ],
            },
          }],
        },
      ],
    }, { from: 'unified', to: 'claude', model: 'claude-sonnet-4' }) as any;

    const toolResult = raw.messages[1].content[0];
    expect(toolResult.content).toEqual([
      { type: 'text', text: '{"temperature":"15 degrees"}' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1n' },
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      },
    ]);
  });

  it('工具响应多模态在 OpenAI-compatible 中保留图片 image_url 和文档 file', () => {
    const raw = convertRequest({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {}, callId: 'call_1' } }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'get_weather',
              callId: 'call_1',
              response: { temperature: '15 degrees' },
              parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'aW1n' } },
                { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
              ],
            },
          }],
        },
      ],
    }, { from: 'unified', to: 'openai-compatible', model: 'gpt-4o' }) as any;

    expect(raw.messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: '{"temperature":"15 degrees"}' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1n' } },
        { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=' } },
      ],
    });
  });

  it('工具响应多模态在 OpenAI Responses 中区分 input_image 和 input_file', () => {
    const raw = convertRequest({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: {}, callId: 'call_1' } }] },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'get_weather',
              callId: 'call_1',
              response: { temperature: '15 degrees' },
              parts: [
                { inlineData: { mimeType: 'image/jpeg', data: 'aW1n', name: 'weather.jpg' } },
                { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=', name: 'weather.pdf' } },
                { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } },
              ],
            },
          }],
        },
      ],
    }, { from: 'unified', to: 'openai-responses', model: 'o3' }) as any;

    expect(raw.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: '{"temperature":"15 degrees"}' },
        { type: 'input_image', detail: 'auto', image_url: 'data:image/jpeg;base64,aW1n' },
        { type: 'input_file', filename: 'weather.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
      ],
    });
  });

  it('工具响应多模态在 Gemini 中过滤为支持的图片/文档并剥离 name', () => {
    const raw = convertRequest({
      contents: [{
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'get_image',
            callId: 'call_1',
            response: { ok: true },
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: 'aW1n', name: 'weather.jpg' } },
              { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
              { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } },
            ],
          },
        }],
      }],
    }, { from: 'unified', to: 'gemini' }) as any;

    expect(raw.contents[0].parts[0].functionResponse.parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: 'aW1n' } },
      { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
    ]);
  });




  it('stream converter 可把 Claude chunk 转成 unified chunk', () => {
    const converter = createStreamConverter({ from: 'claude', to: 'unified', model: 'claude-sonnet-4' });
    const chunk = converter.convert({
      type: 'content_block_delta',
      delta: { type: 'signature_delta', signature: 'sig_stream_1' },
    }) as any;

    expect(chunk.thoughtSignature).toBe('claude:sig_stream_1');
  });

  it('Claude thinking token usage 会保留到 unified，并可转回 Claude', () => {
    const unified = convertResponse({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 25,
        output_tokens: 348,
        output_tokens_details: {
          thinking_tokens: 312,
        },
      },
    }, {
      from: 'claude',
      to: 'unified',
      model: 'claude-opus-4-8',
    }) as any;

    expect(unified.usageMetadata).toMatchObject({
      promptTokenCount: 25,
      candidatesTokenCount: 348,
      thoughtsTokenCount: 312,
      totalTokenCount: 373,
    });

    const roundTrip = convertResponse(unified, {
      from: 'unified',
      to: 'claude',
      model: 'claude-opus-4-8',
    }) as any;

    expect(roundTrip.usage).toMatchObject({
      input_tokens: 25,
      output_tokens: 348,
      output_tokens_details: {
        thinking_tokens: 312,
      },
    });
  });

  it('OpenAI reasoning token usage 会映射为 unified thoughtsTokenCount', () => {
    const unified = convertResponse({
      choices: [{
        message: { role: 'assistant', content: 'done' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 25,
        prompt_cache_hit_tokens: 5,
        completion_tokens: 348,
        completion_tokens_details: {
          reasoning_tokens: 312,
        },
        total_tokens: 373,
      },
    }, {
      from: 'openai-compatible',
      to: 'unified',
      model: 'o3',
    }) as any;

    expect(unified.usageMetadata).toMatchObject({
      promptTokenCount: 25,
      cachedContentTokenCount: 5,
      candidatesTokenCount: 348,
      thoughtsTokenCount: 312,
      totalTokenCount: 373,
    });

    const responses = convertResponse(unified, {
      from: 'unified',
      to: 'openai-responses',
      model: 'o3',
    }) as any;

    expect(responses.usage.output_tokens_details.reasoning_tokens).toBe(312);
    expect(responses.usage.total_tokens).toBe(373);

    const unifiedFromResponses = convertResponse({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'done' }],
      }],
      usage: {
        input_tokens: 36,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 87,
        output_tokens_details: {
          reasoning_tokens: 11,
        },
        total_tokens: 123,
      },
    }, {
      from: 'openai-responses',
      to: 'unified',
      model: 'o3',
    }) as any;

    expect(unifiedFromResponses.usageMetadata.thoughtsTokenCount).toBe(11);
    expect(unifiedFromResponses.usageMetadata.totalTokenCount).toBe(123);
  });

  it('Claude response 的 cache creation usage 会保留到 unified，并可转回 Claude', () => {
    const claudeResponse = {
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-4-8',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        cache_creation_input_tokens: 5120,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 5120,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: 0,
      },
    };

    const unified = convertResponse(claudeResponse, {
      from: 'claude',
      to: 'unified',
      model: 'claude-opus-4-8',
    }) as any;

    expect(unified.usageMetadata).toMatchObject({
      promptTokenCount: 5128,
      cachedContentTokenCount: 0,
      cacheCreationInputTokenCount: 5120,
      cacheCreationInputTokensDetails: {
        ephemeral5mInputTokenCount: 5120,
        ephemeral1hInputTokenCount: 0,
      },
      candidatesTokenCount: 0,
      totalTokenCount: 5128,
    });

    const roundTrip = convertResponse(unified, {
      from: 'unified',
      to: 'claude',
      model: 'claude-opus-4-8',
    }) as any;

    expect(roundTrip.usage).toMatchObject({
      input_tokens: 8,
      cache_creation_input_tokens: 5120,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 5120,
        ephemeral_1h_input_tokens: 0,
      },
      output_tokens: 0,
    });
  });

  it('stream converter 可把 Claude 流式 cache creation usage 转成 unified chunk', () => {
    const converter = createStreamConverter({ from: 'claude', to: 'unified', model: 'claude-opus-4-8' });

    converter.convert({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 8,
          cache_creation_input_tokens: 5120,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 5120,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    });

    const chunk = converter.convert({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: {
        output_tokens: 0,
        output_tokens_details: {
          thinking_tokens: 0,
        },
      },
    }) as any;

    expect(chunk.usageMetadata).toMatchObject({
      promptTokenCount: 5128,
      cachedContentTokenCount: 0,
      cacheCreationInputTokenCount: 5120,
      cacheCreationInputTokensDetails: {
        ephemeral5mInputTokenCount: 5120,
        ephemeral1hInputTokenCount: 0,
      },
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 5128,
    });
  });

  it('stream converter 处理智谱 GLM：input_tokens/cache 只在 message_delta 回传', () => {
    const converter = createStreamConverter({ from: 'claude', to: 'unified', model: 'glm-5.2' });

    // GLM 的 message_start.usage 里 input/output 都是 0
    converter.convert({
      type: 'message_start',
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    });

    // 真实的 input_tokens / cache_read 只在 message_delta 出现
    const chunk = converter.convert({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 334,
        cache_read_input_tokens: 110528,
        output_tokens: 88,
      },
    }) as any;

    expect(chunk.usageMetadata).toMatchObject({
      // 334 + 0(cache_creation) + 110528(cache_read)
      promptTokenCount: 110862,
      cachedContentTokenCount: 110528,
      candidatesTokenCount: 88,
      totalTokenCount: 110950,
    });
  });

  it('stream converter 官方 Claude：message_delta 重复回传相同 input_tokens 不会双计', () => {
    const converter = createStreamConverter({ from: 'claude', to: 'unified', model: 'claude-opus-4-8' });

    converter.convert({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 35907,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 4,
        },
      },
    });

    // 官方 Claude 在 message_delta 里重复相同的 input_tokens
    const chunk = converter.convert({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 35907,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 482,
        output_tokens_details: { thinking_tokens: 88 },
      },
    }) as any;

    expect(chunk.usageMetadata).toMatchObject({
      promptTokenCount: 35907,
      candidatesTokenCount: 482,
      thoughtsTokenCount: 88,
      totalTokenCount: 36389,
    });
  });
});
