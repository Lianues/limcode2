import { IconSwitch } from '@tabler/icons-vue';
import type { ToolDisplayResolver } from './types';

export const switchWorkEnvironmentToolDisplay: ToolDisplayResolver = () => ({
  headerIcon: IconSwitch
});
