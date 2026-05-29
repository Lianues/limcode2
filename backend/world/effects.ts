/**
 * 开放式 effect map：各模块通过 `declare module '@backend/world/effects'` 自行扩展。
 * 根文件只保留 EffectOutbox 与类型插槽，不再手工维护全局大 union。
 */
export interface WorldEffectMap {}

export type WorldEffect = WorldEffectMap[keyof WorldEffectMap];

export class EffectOutbox {
  private readonly queue: WorldEffect[] = [];
  private readonly keys = new Set<string>();

  public push(effect: WorldEffect): void {
    const key = JSON.stringify(effect);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.queue.push(effect);
  }

  public drain(): WorldEffect[] {
    const out = this.queue.splice(0, this.queue.length);
    this.keys.clear();
    return out;
  }
}
