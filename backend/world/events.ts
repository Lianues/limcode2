import type { SystemContext } from '../ecs/types';

/**
 * 开放式事件 payload map：各模块通过 `declare module '@backend/world/events'` 自行扩展。
 * 根文件只提供类型插槽与 readEvents，不再手工维护全局大 union。
 */
export interface WorldEventPayloadMap {}

export type WorldEventType = keyof WorldEventPayloadMap;

export function readEvents<K extends WorldEventType>(ctx: SystemContext, type: K): WorldEventPayloadMap[K][] {
  const out: WorldEventPayloadMap[K][] = [];
  for (const ev of ctx.events) {
    if (ev.type === type) {
      out.push(ev.payload as WorldEventPayloadMap[K]);
    }
  }
  return out;
}
