import { IconMessageDots } from '@tabler/icons-vue';
import type { ToolDisplayResolver } from './types';

export const readConversationToolDisplay: ToolDisplayResolver = () => ({
  headerIcon: IconMessageDots
});
