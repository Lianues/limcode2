import { reactive } from 'vue';
import type {
  AgentConversationLinkRecord,
  AgentRecord,
  ClientPatchOp,
  ClientState,
  MessageRecord,
  SessionRecord,
  ToolCallRecord
} from '@shared/protocol';

interface ClientStateStore {
  version: number;
  currentSessionId: string;
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}

export const clientState = reactive<ClientStateStore>({
  version: 0,
  currentSessionId: '',
  agents: [],
  sessions: [],
  agentConversationLinks: [],
  messages: [],
  toolCalls: []
});

export function applyClientSnapshot(version: number, state: ClientState): void {
  clientState.version = version;
  clientState.agents = state.agents;
  clientState.sessions = state.sessions;
  clientState.agentConversationLinks = state.agentConversationLinks;
  clientState.messages = state.messages;
  clientState.toolCalls = state.toolCalls;

  const hasCurrent = !!clientState.currentSessionId && clientState.sessions.some((session) => session.id === clientState.currentSessionId);
  if (!hasCurrent) {
    clientState.currentSessionId = clientState.sessions.find((session) => session.id === 'default')?.id
      ?? clientState.sessions[0]?.id
      ?? '';
  }
}

export function applyClientPatch(version: number, patches: ClientPatchOp[]): boolean {
  if (version !== clientState.version + 1) {
    return false;
  }
  for (const patch of patches) {
    applyClientPatchOp(patch);
  }
  clientState.version = version;
  return true;
}

function applyClientPatchOp(patch: ClientPatchOp): void {
  switch (patch.kind) {
    case 'agent.upsert':
      upsert(clientState.agents, patch.agent, (item) => item.id === patch.agent.id);
      break;
    case 'agent.remove':
      remove(clientState.agents, (item) => item.id === patch.id);
      break;
    case 'session.upsert':
      upsert(clientState.sessions, patch.session, (item) => item.id === patch.session.id);
      break;
    case 'session.remove':
      remove(clientState.sessions, (item) => item.id === patch.id);
      if (clientState.currentSessionId === patch.id) clientState.currentSessionId = clientState.sessions[0]?.id ?? '';
      break;
    case 'agentConversationLink.upsert':
      upsert(clientState.agentConversationLinks, patch.link, (item) => item.id === patch.link.id);
      break;
    case 'agentConversationLink.remove':
      remove(clientState.agentConversationLinks, (item) => item.id === patch.id);
      break;
    case 'message.upsert':
      upsert(clientState.messages, patch.message, (item) => item.id === patch.message.id);
      clientState.messages.sort((a, b) => a.seq - b.seq);
      break;
    case 'message.remove':
      remove(clientState.messages, (item) => item.id === patch.id);
      break;
    case 'message.appendText': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) message.text += patch.delta;
      break;
    }
    case 'message.status': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) message.status = patch.status;
      break;
    }
    case 'toolcall.upsert':
      upsert(clientState.toolCalls, patch.toolCall, (item) => item.id === patch.toolCall.id);
      break;
    case 'toolcall.remove':
      remove(clientState.toolCalls, (item) => item.id === patch.id);
      break;
    default:
      break;
  }
}

function upsert<T>(list: T[], item: T, predicate: (candidate: T) => boolean): void {
  const index = list.findIndex(predicate);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function remove<T>(list: T[], predicate: (candidate: T) => boolean): void {
  const index = list.findIndex(predicate);
  if (index >= 0) list.splice(index, 1);
}
