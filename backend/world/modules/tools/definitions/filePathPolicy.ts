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
    description: '最高优先级开关。开启时允许任意项目外路径；关闭时，仅允许解析到当前项目根目录或已勾选允许的本地工作环境根目录内，禁止其他绝对项目外路径与 ../ 逃逸。',
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
    : 'Supports relative paths and absolute paths. Relative paths are resolved from the current work environment root; by default this tool only allows paths inside the current project root or explicitly allowed local work environment roots.';
}
