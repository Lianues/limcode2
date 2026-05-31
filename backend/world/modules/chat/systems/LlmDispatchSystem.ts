import { defineQuery, defineSystem } from '../../../../ecs/types';
import { AgentModeLink, ModeModelProfileLink, ModeSystemPromptLink, ModeToolPolicyLink, ModelProfile, SystemPrompt, ToolPolicy } from '../../mode/components';
import {
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModelProfileLink,
  RunModeLink,
  RunSystemPromptLink,
  RunToolPolicyLink
} from '../../agentRun/components';
import { ToolCall, ToolState } from '../../tools/components';
import { ToolSchemasKey } from '../../tools/resources';
import { InFlight, LlmRequest, Message, PartOf } from '../components';
import { textContent } from '../../../../../shared/protocol';
import type { LlmModelSettings } from '../../llm/contracts';
import {
  activeContextPolicyForRun,
  activeModelProfileForRun,
  activeSystemPromptForRun,
  activeToolPolicyForRun
} from '../../agentRun/queries';
import { buildRunContextContents } from '../../agentRun/contextPolicy';

const PendingLlmRequestsQuery = defineQuery({
  name: 'PendingLlmRequests',
  all: [LlmRequest],
  none: [InFlight],
  read: [LlmRequest],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

const LlmContextLookupComponents = [
  Message,
  PartOf,
  MessageRunLink,
  AgentRunSourceLink,
  AgentRunTargetLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModeLink,
  RunSystemPromptLink,
  RunModelProfileLink,
  RunToolPolicyLink,
  AgentModeLink,
  ModeSystemPromptLink,
  ModeModelProfileLink,
  ModeToolPolicyLink,
  SystemPrompt,
  ModelProfile,
  ToolPolicy,
  ToolCall,
  ToolState
] as const;

export const LlmDispatchSystem = defineSystem({
  name: 'LlmDispatchSystem',
  worker: { modulePath: '../world/modules/chat/systems/LlmDispatchSystem', exportName: 'LlmDispatchSystem' },
  access: {
    queries: [PendingLlmRequestsQuery],
    reads: { components: LlmContextLookupComponents },
    resources: { read: [ToolSchemasKey] },
    effects: { emit: ['llm.start'] }
  },
  run({ world, cmd }) {
    const requests = world.query(LlmRequest).filter((request) => !world.has(request, InFlight));
    if (requests.length === 0) return;

    const allTools = world.getResource(ToolSchemasKey);

    for (const request of requests) {
      const data = world.get(request, LlmRequest);
      if (!data) continue;

      const systemPrompt = activeSystemPromptForRun(world, data.run)?.text;
      const modelProfile = activeModelProfileForRun(world, data.run);
      const model = modelProfile === undefined
        ? undefined
        : { provider: modelProfile.provider, model: modelProfile.model, temperature: modelProfile.temperature } satisfies LlmModelSettings;
      const toolPolicy = activeToolPolicyForRun(world, data.run);
      const tools = toolPolicy
        ? allTools.filter((tool) => toolPolicy.allowedTools.includes(tool.name))
        : [];

      const contextPolicy = activeContextPolicyForRun(world, data.run);
      const contents = buildRunContextContents(world, {
        run: data.run,
        conversation: data.conversation,
        modelMessage: data.modelMessage,
        policy: contextPolicy
      });

      cmd.effect({
        kind: 'llm.start',
        request: {
          id: data.id,
          systemInstruction: systemPrompt ? textContent('user', systemPrompt) : undefined,
          contents,
          tools,
          model
        }
      });
      cmd.add(request, InFlight, { kind: 'llm', startedAt: Date.now() });
    }
  }
});
