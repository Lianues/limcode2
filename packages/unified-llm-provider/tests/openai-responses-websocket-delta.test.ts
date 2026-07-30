import { describe, expect, it } from 'vitest';
import { mergeOpenAIResponsesWebSocketEvents } from '../src/llm/websocket-openai-responses.js';

describe('OpenAI Responses WebSocket queued delta merge', () => {
  it('merges adjacent text deltas for the same output item without changing order metadata', () => {
    const merged = mergeOpenAIResponsesWebSocketEvents(
      {
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 10,
        delta: '你',
      },
      {
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        sequence_number: 11,
        delta: '好',
      },
    );

    expect(merged).toMatchObject({
      type: 'response.output_text.delta',
      response_id: 'resp_1',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 11,
      delta: '你好',
    });
  });

  it('merges reasoning and function-call argument deltas for the same stream identity', () => {
    expect(mergeOpenAIResponsesWebSocketEvents(
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'a' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'b' },
    )).toMatchObject({ delta: 'ab' });

    expect(mergeOpenAIResponsesWebSocketEvents(
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"a"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':1}' },
    )).toMatchObject({ delta: '{"a":1}' });
  });

  it('does not merge different items, different event types, or terminal events', () => {
    expect(mergeOpenAIResponsesWebSocketEvents(
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'a' },
      { type: 'response.output_text.delta', item_id: 'msg_2', output_index: 0, content_index: 0, delta: 'b' },
    )).toBeUndefined();

    expect(mergeOpenAIResponsesWebSocketEvents(
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'a' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'b' },
    )).toBeUndefined();

    expect(mergeOpenAIResponsesWebSocketEvents(
      { type: 'response.completed', response: { id: 'resp_1' } },
      { type: 'response.completed', response: { id: 'resp_2' } },
    )).toBeUndefined();
  });
});
