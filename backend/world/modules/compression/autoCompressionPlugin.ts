import type { WorldPlugin } from '../../plugin';
import { AutoCompressionSystem } from './systems/AutoCompressionSystem';

/**
 * 自动压缩协调依赖已经提交的工具结果，因此单独安装在 toolsPlugin 之后、chatPlugin 之前。
 * CompressionSystem 本体仍由 compressionPlugin 提前注册并负责手动事件与 compact 结果。
 */
export function autoCompressionPlugin(): WorldPlugin {
  return {
    name: 'autoCompression',
    install(ctx) {
      ctx.scheduler.add(AutoCompressionSystem);
    }
  };
}
