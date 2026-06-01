/**
 * 开放式 effect map：各模块通过 `declare module '@backend/world/effects'` 自行扩展。
 * 根文件只保留 EffectOutbox 与类型插槽，不再手工维护全局大 union。
 */
export interface WorldEffectMap {}

export type WorldEffect = WorldEffectMap[keyof WorldEffectMap];

export class EffectOutbox {
  private readonly queue: WorldEffect[] = [];

  public push(effect: WorldEffect): void {
    this.queue.push(effect);
  }

  public drain(): WorldEffect[] {
    return this.queue.splice(0, this.queue.length);
  }

  public drainWhere(predicate: (effect: WorldEffect) => boolean): WorldEffect[] {
    const out: WorldEffect[] = [];
    const kept: WorldEffect[] = [];

    for (const effect of this.queue) {
      (predicate(effect) ? out : kept).push(effect);
    }

    this.queue.splice(0, this.queue.length, ...kept);
    return out;
  }
}
