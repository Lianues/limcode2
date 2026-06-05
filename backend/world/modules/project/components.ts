import { defineComponent, type Entity } from '../../../ecs/types';
import type { ConversationProjectRole, ProjectContextKind } from '../../../../shared/protocol';

export interface ProjectContextData {
  id: string;
  kind: ProjectContextKind;
  uri: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}
export const ProjectContext = defineComponent<ProjectContextData>('ProjectContext');

export interface ConversationProjectLinkData {
  id: string;
  conversation: Entity;
  projectContext: Entity;
  role: ConversationProjectRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationProjectLink = defineComponent<ConversationProjectLinkData>('ConversationProjectLink');
