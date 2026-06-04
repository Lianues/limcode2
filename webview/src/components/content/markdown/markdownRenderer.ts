type MarkdownToken = {
  attrs: Array<[string, string]> | null;
  attrIndex(name: string): number;
  attrPush(attrData: [string, string]): void;
};

type MarkdownRenderer = {
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
  render(text: string): string;
  renderer: {
    rules: Record<string, MarkdownRenderRule | undefined>;
  };
};

type MarkdownItConstructor = new (options?: MarkdownOptions) => MarkdownParser;

const FINAL_CACHE_LIMIT = 80;

let parserPromise: Promise<MarkdownParser> | undefined;
const finalRenderCache = new Map<string, string>();

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

function rememberFinalRender(text: string, html: string): void {
  finalRenderCache.set(text, html);
  if (finalRenderCache.size <= FINAL_CACHE_LIMIT) return;

  const oldestKey = finalRenderCache.keys().next().value as string | undefined;
  if (oldestKey !== undefined) finalRenderCache.delete(oldestKey);
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
