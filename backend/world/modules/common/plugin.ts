import type { WorldPlugin } from '../../plugin';

export function commonPlugin(): WorldPlugin {
  return {
    name: 'common',
    install() {
      // 通用模块当前不再向 World 注入 mutable EffectOutbox。
      // System 统一通过 CommandBuffer 的 cmd.effect(...) 产出 effect，
      // Scheduler/Application 负责收集并执行。
    }
  };
}
