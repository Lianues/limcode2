import type { LlmProviderKind, LlmReasoningMode, LlmThinkingLevel } from '@shared/protocol';

export type LlmParameterValueType = 'number' | 'boolean' | 'enum';

export interface LlmParameterDefinition {
  /** 内部稳定 key，用于识别参数定义。 */
  key: string;
  /** LimCode 写入 generationConfig 的统一路径，不随 provider 改变。 */
  path: string[];
  /** 面向用户展示的参数名，会按 provider 调整为更接近原生字段的名称。 */
  label: string;
  /** 面向用户展示的说明，会按 provider 补充原生映射说明。 */
  description: string;
  /** 当前 provider 下最终请求体里的原生字段路径，仅用于 UI 展示。 */
  displayPath: string;
  valueType: LlmParameterValueType;
  defaultValue: number | boolean | LlmThinkingLevel | LlmReasoningMode;
  providers: readonly LlmProviderKind[];
  options?: readonly { value: string; label: string; description?: string }[];
}

type BaseLlmParameterDefinition = Omit<LlmParameterDefinition, 'displayPath'>;

interface ProviderParameterDisplay {
  label?: string;
  path: string;
  description?: string;
}

const ALL_PROVIDERS = ['openai-compatible', 'openai-responses', 'claude', 'gemini', 'deepseek'] as const satisfies readonly LlmProviderKind[];
const GEMINI_CLAUDE = ['gemini', 'claude'] as const satisfies readonly LlmProviderKind[];
const REASONING_MODE_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'pro', label: 'Pro' }
] as const satisfies readonly { value: LlmReasoningMode; label: string }[];
const THINKING_LEVEL_OPTIONS: Record<LlmProviderKind, readonly { value: LlmThinkingLevel; label: string; description?: string }[]> = {
  gemini: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
  ],
  claude: [
    { value: 'none', label: 'None', description: '关闭思考' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' }
  ],
  'openai-compatible': [
    { value: 'none', label: 'None', description: '关闭推理强度' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' }
  ],
  'openai-responses': [
    { value: 'none', label: 'None', description: '关闭推理强度' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' }
  ],
  deepseek: [
    { value: 'none', label: 'None', description: '关闭思考' },
    { value: 'high', label: 'High', description: '启用思考' },
    { value: 'max', label: 'Max', description: '最大思考强度' }
  ]
};

const PROVIDER_PARAMETER_DISPLAY: Record<LlmProviderKind, Record<string, ProviderParameterDisplay>> = {
  gemini: {
    temperature: { path: 'generationConfig.temperature' },
    topP: { path: 'generationConfig.topP' },
    topK: { path: 'generationConfig.topK' },
    maxOutputTokens: { path: 'generationConfig.maxOutputTokens' },
    includeThoughts: { path: 'generationConfig.thinkingConfig.includeThoughts' },
    thinkingBudget: { path: 'generationConfig.thinkingConfig.thinkingBudget' },
    thinkingLevel: { path: 'generationConfig.thinkingConfig.thinkingLevel', label: 'Thinking Level' }
  },
  claude: {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    topK: { path: 'top_k', label: 'Top K / top_k' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingBudget: {
      path: 'thinking.budget_tokens',
      label: 'Thinking Budget',
      description: 'Claude 原生思考 token 预算；如果同时设置有效 Thinking Level，unified 会优先使用等级映射。'
    },
    thinkingLevel: {
      path: 'thinking.type / output_config.effort',
      label: 'Thinking Effort',
      description: 'Claude：none 映射为 thinking.type=disabled；low/high 等映射为 thinking.type=adaptive + output_config.effort。'
    }
  },
  'openai-compatible': {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingLevel: {
      path: 'reasoning_effort',
      label: 'Reasoning Effort',
      description: 'OpenAI Chat / Compatible 原生推理强度字段。'
    }
  },
  'openai-responses': {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_output_tokens', label: 'Max Output Tokens' },
    reasoningMode: {
      path: 'reasoning.mode',
      label: 'Reasoning Mode',
      description: 'OpenAI Responses 推理模式：standard 为标准模式，pro 为专业模式。'
    },
    thinkingLevel: {
      path: 'reasoning.effort',
      label: 'Reasoning Effort',
      description: "OpenAI Responses 原生推理字段：reasoning.effort；unified 会补 reasoning.summary='auto'。"
    }
  },
  deepseek: {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingLevel: {
      path: 'thinking.type / reasoning_effort',
      label: 'DeepSeek Thinking',
      description: 'DeepSeek 原生思考控制：none 关闭；high/max 映射为 thinking.type=enabled 并设置 reasoning_effort。'
    }
  }
};

export const LLM_PARAMETER_DEFINITIONS: readonly BaseLlmParameterDefinition[] = [
  {
    key: 'temperature',
    path: ['temperature'],
    label: 'Temperature',
    description: '控制输出随机性，值越高越发散。',
    valueType: 'number',
    defaultValue: 0.7,
    providers: ALL_PROVIDERS
  },
  {
    key: 'topP',
    path: ['topP'],
    label: 'Top P',
    description: '核采样阈值，通常取 0-1。',
    valueType: 'number',
    defaultValue: 0.9,
    providers: ALL_PROVIDERS
  },
  {
    key: 'topK',
    path: ['topK'],
    label: 'Top K',
    description: '候选 token 数量限制；当前 unified 默认映射到 Gemini / Claude。',
    valueType: 'number',
    defaultValue: 40,
    providers: GEMINI_CLAUDE
  },
  {
    key: 'maxOutputTokens',
    path: ['maxOutputTokens'],
    label: 'Max Output Tokens',
    description: '限制单次响应输出 token 数。',
    valueType: 'number',
    defaultValue: 1024,
    providers: ALL_PROVIDERS
  },
  {
    key: 'includeThoughts',
    path: ['thinkingConfig', 'includeThoughts'],
    label: 'Include Thoughts',
    description: 'Gemini 原生思考输出开关；其他 provider 会忽略该统一字段。',
    valueType: 'boolean',
    defaultValue: true,
    providers: ['gemini']
  },
  {
    key: 'thinkingBudget',
    path: ['thinkingConfig', 'thinkingBudget'],
    label: 'Thinking Budget',
    description: '思考 token 预算；Gemini / Claude 会按 unified 规则映射。',
    valueType: 'number',
    defaultValue: 10000,
    providers: GEMINI_CLAUDE
  },
  {
    key: 'reasoningMode',
    path: ['thinkingConfig', 'reasoningMode'],
    label: 'Reasoning Mode',
    description: 'OpenAI Responses 推理模式。',
    valueType: 'enum',
    defaultValue: 'standard',
    providers: ['openai-responses'],
    options: REASONING_MODE_OPTIONS
  }
];

export function thinkingLevelDefinition(provider: LlmProviderKind): LlmParameterDefinition {
  const options = THINKING_LEVEL_OPTIONS[provider] ?? THINKING_LEVEL_OPTIONS['openai-compatible'];
  return withProviderDisplay({
    key: 'thinkingLevel',
    path: ['thinkingConfig', 'thinkingLevel'],
    label: 'Thinking Level',
    description: '思考 / 推理强度等级；实际请求体映射交给 unified-llm-provider。',
    valueType: 'enum',
    defaultValue: options[0]?.value ?? 'low',
    providers: [provider],
    options
  }, provider);
}

export function parameterDefinitionsForProvider(provider: LlmProviderKind): LlmParameterDefinition[] {
  return [
    ...LLM_PARAMETER_DEFINITIONS
      .filter((definition) => definition.providers.includes(provider))
      .map((definition) => withProviderDisplay(definition, provider)),
    thinkingLevelDefinition(provider)
  ];
}

export function labelForProvider(provider: LlmProviderKind): string {
  switch (provider) {
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'deepseek':
      return 'DeepSeek';
    default:
      return provider;
  }
}

function withProviderDisplay(definition: BaseLlmParameterDefinition, provider: LlmProviderKind): LlmParameterDefinition {
  const display = PROVIDER_PARAMETER_DISPLAY[provider]?.[definition.key];
  return {
    ...definition,
    label: display?.label ?? definition.label,
    description: display?.description ?? definition.description,
    displayPath: display?.path ?? definition.path.join('.')
  };
}
