export interface ToolDiffPreviewItemLike {
  kind: 'create' | 'update' | 'delete' | 'replace';
  path: string;
  title?: string;
  beforeText?: string;
  afterText?: string;
  patch?: string;
}

export interface ToolDiffPreviewResponseLike {
  toolName: string;
  title: string;
  summary?: string;
  items?: ToolDiffPreviewItemLike[];
}
