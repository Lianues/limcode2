type MarkdownToken = {
  attrs: Array<[string, string]> | null;
  type: string;
  content: string;
  info: string;
  attrIndex(name: string): number;
  attrPush(attrData: [string, string]): void;
};

type MarkdownRenderer = {
  render(tokens: MarkdownToken[], options: MarkdownOptions, env: unknown): string;
  renderToken(tokens: MarkdownToken[], index: number, options: MarkdownOptions): string;
};

type MarkdownOptions = Record<string, unknown>;
type MarkdownRenderRule = (
  tokens: MarkdownToken[],
  index: number,
  options: MarkdownOptions,
  env: unknown,
  self: MarkdownRenderer
) => string;

type MarkdownParser = {
  options: MarkdownOptions;
  render(text: string): string;
  parse(text: string, env: unknown): MarkdownToken[];
  renderer: MarkdownRenderer & {
    rules: Record<string, MarkdownRenderRule | undefined>;
  };
};

type MarkdownItConstructor = new (options?: MarkdownOptions) => MarkdownParser;

export type MarkdownRenderedPart =
  | { kind: 'html'; html: string }
  | { kind: 'code'; code: string; language: string; info: string };

const FINAL_CACHE_LIMIT = 80;

let parserPromise: Promise<MarkdownParser> | undefined;
const finalRenderCache = new Map<string, string>();
const finalPartCache = new Map<string, MarkdownRenderedPart[]>();

/** 渲染 Markdown。streaming=true 时不写入最终缓存，避免流式增量产生大量一次性 key。 */
export async function renderMarkdown(text: string, options: { streaming?: boolean } = {}): Promise<string> {
  const normalized = text.trimStart();
  if (!normalized) return '';

  if (!options.streaming) {
    const cached = finalRenderCache.get(normalized);
    if (cached !== undefined) {
      finalRenderCache.delete(normalized);
      finalRenderCache.set(normalized, cached);
      return cached;
    }
  }

  const parser = await getParser();
  const html = parser.render(normalized);

  if (!options.streaming) rememberFinalRender(normalized, html);
  return html;
}

/**
 * 渲染 Markdown 为可由 Vue 组合展示的片段。
 * fenced / indented code block 会拆成 code 片段，交给专门的代码块显示器处理。
 */
export async function renderMarkdownParts(text: string, options: { streaming?: boolean } = {}): Promise<MarkdownRenderedPart[]> {
  const normalized = text.trimStart();
  if (!normalized) return [];

  if (!options.streaming) {
    const cached = finalPartCache.get(normalized);
    if (cached !== undefined) {
      finalPartCache.delete(normalized);
      finalPartCache.set(normalized, cached);
      return cached;
    }
  }

  const parser = await getParser();
  const tokens = parser.parse(normalized, {});
  const parts = tokensToRenderedParts(parser, tokens);

  if (!options.streaming) rememberFinalParts(normalized, parts);
  return parts;
}

function tokensToRenderedParts(parser: MarkdownParser, tokens: MarkdownToken[]): MarkdownRenderedPart[] {
  const parts: MarkdownRenderedPart[] = [];
  let htmlTokens: MarkdownToken[] = [];

  const flushHtml = (): void => {
    if (htmlTokens.length === 0) return;
    const html = parser.renderer.render(htmlTokens, parser.options, {}).trim();
    if (html) parts.push({ kind: 'html', html });
    htmlTokens = [];
  };

  for (const token of tokens) {
    if (token.type === 'fence' || token.type === 'code_block') {
      flushHtml();
      parts.push({
        kind: 'code',
        code: token.content,
        language: languageFromInfo(token.info),
        info: token.info?.trim() ?? ''
      });
      continue;
    }

    htmlTokens.push(token);
  }

  flushHtml();
  return parts;
}

function languageFromInfo(info: string | undefined): string {
  const trimmed = info?.trim() ?? '';
  if (!trimmed) return '';
  const classMatch = trimmed.match(/^\{\.?([\w+#.-]+)/);
  return classMatch?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
}

function rememberFinalRender(text: string, html: string): void {
  finalRenderCache.set(text, html);
  trimFinalCache(finalRenderCache);
}

function rememberFinalParts(text: string, parts: MarkdownRenderedPart[]): void {
  finalPartCache.set(text, parts);
  trimFinalCache(finalPartCache);
}

function trimFinalCache(cache: Map<string, unknown>): void {
  if (cache.size <= FINAL_CACHE_LIMIT) return;

  const oldestKey = cache.keys().next().value as string | undefined;
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

function getParser(): Promise<MarkdownParser> {
  parserPromise ??= import('markdown-it')
    .then((module) => createParser(markdownItConstructorFromModule(module)))
    .catch((error) => {
      parserPromise = undefined;
      throw error;
    });
  return parserPromise;
}

function markdownItConstructorFromModule(module: unknown): MarkdownItConstructor {
  const candidate = (module as { default?: unknown }).default ?? module;
  return candidate as MarkdownItConstructor;
}

function createParser(MarkdownItCtor: MarkdownItConstructor): MarkdownParser {
  const parser = new MarkdownItCtor({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false
  });

  const defaultLinkOpen = parser.renderer.rules.link_open;
  parser.renderer.rules.link_open = (tokens, index, options, env, self) => {
    setTokenAttr(tokens[index], 'target', '_blank');
    setTokenAttr(tokens[index], 'rel', 'noreferrer noopener');
    return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };

  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.image = (tokens, index, options, env, self) => {
    setTokenAttr(tokens[index], 'loading', 'lazy');
    setTokenAttr(tokens[index], 'referrerpolicy', 'no-referrer');
    return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };

  return parser;
}

function setTokenAttr(token: MarkdownToken, name: string, value: string): void {
  const attrIndex = token.attrIndex(name);
  if (attrIndex < 0) {
    token.attrPush([name, value]);
    return;
  }
  if (token.attrs) token.attrs[attrIndex] = [name, value];
}
