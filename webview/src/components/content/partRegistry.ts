import type { Component } from 'vue';
import { isVisibleTextPart, type ContentPart } from '@shared/protocol';
import TextPartView from './parts/TextPartView.vue';

/**
 * 富内容显示子组件注册表。
 *
 * MVP 只注册 text。后续要新增显示子组件（thought / functionCall 工具卡片 / code / fileData 等）时：
 *   1. 在 parts/ 下新增组件；
 *   2. 在 COMPONENTS 里登记；
 *   3. 在 toRenderNodes 里把对应 part 归约成渲染节点。
 * 显示层无需改动其它代码。
 */
export type RichPartKind = 'text';

export interface RichRenderNode {
  readonly key: string;
  readonly kind: RichPartKind;
  readonly props: Record<string, unknown>;
}

const COMPONENTS: Record<RichPartKind, Component> = {
  text: TextPartView
};

export function partViewComponent(kind: RichPartKind): Component {
  return COMPONENTS[kind];
}

/** 把消息 parts 归约为渲染节点。MVP：仅把可见文本拼成一个 text 节点。 */
export function toRenderNodes(parts: readonly ContentPart[]): RichRenderNode[] {
  const text = parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
    .trimStart();

  if (!text) return [];
  return [{ key: 'text', kind: 'text', props: { text } }];
}
