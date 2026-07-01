import { IconTerminal2 } from '@tabler/icons-vue';
import { parseShellArgs, shellInputSections, shellOutputSections } from './shellToolModel';
import type { ToolDisplayResolver } from './types';

export const shellToolDisplay: ToolDisplayResolver = (context) => {
  return {
    headerIcon: IconTerminal2,
    inputSections: shellInputSections(parseShellArgs(context.args), context),
    outputSections: shellOutputSections(context)
  };
};
