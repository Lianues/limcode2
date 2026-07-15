declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';
  import type { KatexOptions } from 'katex';

  export type TexmathDelimiter = 'dollars' | 'brackets' | 'doxygen' | 'gitlab' | 'julia' | 'kramdown' | 'beg_end';

  export interface TexmathOptions {
    engine?: typeof import('katex');
    delimiters?: TexmathDelimiter | TexmathDelimiter[];
    outerSpace?: boolean;
    macros?: Record<string, string>;
    katexOptions?: KatexOptions & { macros?: Record<string, string> };
  }

  const texmath: (md: MarkdownIt, options?: TexmathOptions) => void;
  export default texmath;
}
