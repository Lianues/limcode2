import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { chatStateProjectionReads, projectChatState } from './stateProjection';

export const chatStorageStateContributor = defineStorageStateContributor({
  key: 'chat',
  reads: chatStateProjectionReads,
  project: projectChatState
});
