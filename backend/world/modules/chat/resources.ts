import { defineResource } from '../../../ecs/types';

/**
 * 当前仍有 VS Code 主面板承载的 conversation id。
 *
 * 这是 Extension Host 连接状态的运行时投影，不属于 Conversation 持久化数据；
 * System 只读取这份纯数据，不直接依赖 vscode.Webview capability。
 */
export const OpenConversationPanelIdsKey = defineResource<readonly string[]>('OpenConversationPanelIds');
