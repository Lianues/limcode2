import type { ClientState, ConversationProjectLinkRecord, ProjectContextRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import { ConversationProjectLink, ProjectContext } from './components';

export const projectStateProjectionReads: AccessDeclaration = {
  components: [ProjectContext, ConversationProjectLink, Conversation]
};

export function projectStateProjection(world: WorldReader): Partial<ClientState> {
  const projectContexts: ProjectContextRecord[] = world.query(ProjectContext).map((entity) => {
    const context = world.get(entity, ProjectContext)!;
    return {
      id: context.id,
      kind: context.kind,
      uri: context.uri,
      name: context.name,
      createdAt: context.createdAt,
      updatedAt: context.updatedAt
    };
  });

  const conversationProjectLinks: ConversationProjectLinkRecord[] = world
    .query(ConversationProjectLink)
    .map((entity) => buildConversationProjectLinkRecord(world, entity))
    .filter((item): item is ConversationProjectLinkRecord => item !== undefined);

  return { projectContexts, conversationProjectLinks };
}

function buildConversationProjectLinkRecord(world: WorldReader, entity: number): ConversationProjectLinkRecord | undefined {
  const link = world.get(entity, ConversationProjectLink);
  if (!link) return undefined;

  const conversation = world.get(link.conversation, Conversation);
  const projectContext = world.get(link.projectContext, ProjectContext);
  if (!conversation || !projectContext) return undefined;

  return {
    id: link.id,
    conversationId: conversation.id,
    projectContextId: projectContext.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}
