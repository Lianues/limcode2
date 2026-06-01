import { createHostApi } from '../platform/createHostApi';
import { Bridge } from './bridge';

type BridgeHostWindow = Window & typeof globalThis & {
  __limcodeBridge?: Bridge;
};

function getOrCreateBridge(): Bridge {
  const limcodeWindow = window as BridgeHostWindow;
  // 缓存到 window，避免 Vite HMR 重新执行模块时重复 new Bridge / 重复注册宿主消息监听。
  limcodeWindow.__limcodeBridge ??= new Bridge(createHostApi());
  return limcodeWindow.__limcodeBridge;
}

/** 全局唯一的协议桥单例。组件不直接引用它，统一通过 stores / composables 间接使用。 */
export const bridge = getOrCreateBridge();

export { Bridge } from './bridge';
export { BridgeMessageType } from '@shared/protocol';
