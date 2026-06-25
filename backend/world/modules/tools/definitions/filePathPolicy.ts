import {
  ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY,
  type ToolConfigFieldRecord,
  type ToolConfigRecord
} from '../../../../../shared/protocol';

export function allowOutsideProjectPathsField(defaultValue: boolean): ToolConfigFieldRecord {
  return {
    key: ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY,
    label: '允许使用项目外路径',
    type: 'boolean',
    description: '关闭时，仅允许解析到当前工作环境/项目根目录内的路径，禁止绝对项目外路径与 ../ 逃逸。',
    defaultValue
  };
}

export function allowOutsideProjectPathsDefaultConfig(defaultValue: boolean): ToolConfigRecord {
  return { [ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY]: defaultValue };
}

export function allowOutsideProjectPathsFromConfig(config: ToolConfigRecord | undefined, defaultValue: boolean): boolean {
  const value = config?.[ALLOW_OUTSIDE_PROJECT_PATHS_CONFIG_KEY];
  return typeof value === 'boolean' ? value : defaultValue;
}

export function filePathPolicyDescription(defaultAllowsOutsideProjectPaths: boolean): string {
  return defaultAllowsOutsideProjectPaths
    ? 'Supports relative paths and absolute paths. Relative paths are resolved from the current work environment root; this tool policy allows project-external paths by default.'
    : 'Supports relative paths and absolute paths. Relative paths are resolved from the current work environment root; by default this tool only allows paths inside the current project/work-environment root.';
}
