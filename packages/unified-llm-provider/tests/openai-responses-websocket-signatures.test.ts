import { describe, expect, it } from 'vitest';
import { normalizeCompletedResponseForStreamSignatures } from '../src/llm/websocket-openai-responses.js';

describe('OpenAI Responses WebSocket streamed reasoning signatures', () => {
  it('uses output_item.done encrypted_content instead of response.completed encrypted_content', () => {
    const completed = {
      id: 'resp_1',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'reasoning' }],
          encrypted_content: 'completed-signature',
        },
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{}',
        },
      ],
    };

    const normalized = normalizeCompletedResponseForStreamSignatures(completed, [
      { itemId: 'rs_1', outputIndex: 0, encryptedContent: 'output-item-done-signature' },
    ]) as typeof completed;

    expect(normalized.output[0]).toEqual({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'reasoning' }],
      encrypted_content: 'output-item-done-signature',
    });
    expect(normalized.output[1]).toEqual(completed.output[1]);
    expect(completed.output[0].encrypted_content).toBe('completed-signature');
  });

  it('removes completed encrypted_content when HTTP streaming did not receive one in output_item.done', () => {
    const normalized = normalizeCompletedResponseForStreamSignatures({
      output: [{ id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'completed-only-signature' }],
    }, [
      { itemId: 'rs_1', outputIndex: 0 },
    ]) as { output: Array<Record<string, unknown>> };

    expect(normalized.output[0]).toEqual({ id: 'rs_1', type: 'reasoning', summary: [] });
  });

  it('matches multiple reasoning items by item id and output index', () => {
    const normalized = normalizeCompletedResponseForStreamSignatures({
      output: [
        { id: 'rs_1', type: 'reasoning', encrypted_content: 'completed-1', summary: [] },
        { type: 'message', role: 'assistant', content: [] },
        { id: 'rs_2', type: 'reasoning', encrypted_content: 'completed-2', summary: [] },
      ],
    }, [
      { itemId: 'rs_1', encryptedContent: 'streamed-1' },
      { outputIndex: 2, encryptedContent: 'streamed-2' },
    ]) as { output: Array<Record<string, unknown>> };

    expect(normalized.output[0].encrypted_content).toBe('streamed-1');
    expect(normalized.output[1]).toEqual({ type: 'message', role: 'assistant', content: [] });
    expect(normalized.output[2].encrypted_content).toBe('streamed-2');
  });
});
