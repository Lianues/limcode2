import type { ProjectFolderCandidateRecord, SidebarConversationHistoryEntry } from '@shared/protocol';

export const SIDEBAR_MESSAGE = {
  openConversation: 'openConversation',
  newConversation: 'newConversation',
  openGlobalSettings: 'openGlobalSettings',
  refreshConversationHistory: 'refreshConversationHistory',
  state: 'sidebar.state',
  ready: 'sidebar.ready',
  renameConversation: 'renameConversation',
  deleteConversation: 'deleteConversation',
  abortConversation: 'abortConversation'
} as const;

export type SidebarToExtensionMessage =
  | { type: typeof SIDEBAR_MESSAGE.ready }
  | { type: typeof SIDEBAR_MESSAGE.openConversation; conversationId: string }
  | { type: typeof SIDEBAR_MESSAGE.newConversation; projectFolderUri?: string }
  | { type: typeof SIDEBAR_MESSAGE.openGlobalSettings }
  | { type: typeof SIDEBAR_MESSAGE.refreshConversationHistory }
  | { type: typeof SIDEBAR_MESSAGE.renameConversation; conversationId: string }
  | { type: typeof SIDEBAR_MESSAGE.deleteConversation; conversationId: string }
  | { type: typeof SIDEBAR_MESSAGE.abortConversation; conversationId: string };

export type ExtensionToSidebarMessage =
  | {
      type: typeof SIDEBAR_MESSAGE.state;
      entries: SidebarConversationHistoryEntry[];
      projectFolders: ProjectFolderCandidateRecord[];
    };

export type { ProjectFolderCandidateRecord, SidebarConversationHistoryEntry };
