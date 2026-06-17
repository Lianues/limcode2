import type { WorkEnvironmentKind } from '@shared/protocol';
import { REMOTE_SERVER_WORK_ENVIRONMENT_KIND } from '@shared/workEnvironmentCatalog';

export interface WorkEnvironmentCreateAction {
  id: string;
  kind: WorkEnvironmentKind;
  label: string;
  title: string;
  description: string;
  inputLabel: string;
  placeholder: string;
  confirmLabel: string;
}

export const WORK_ENVIRONMENT_CREATE_ACTIONS: WorkEnvironmentCreateAction[] = [
  {
    id: 'remote-server',
    kind: REMOTE_SERVER_WORK_ENVIRONMENT_KIND,
    label: '新建服务器环境',
    title: '新建服务器环境',
    description: '输入 SSH Host，也就是实际用于 ssh user@host 的主机名、IP、域名或 SSH 配置别名。创建后可继续编辑 Name、User、IdentityFile、Password、Workdir 等字段。',
    inputLabel: 'Host',
    placeholder: '例如：93.127.137.197',
    confirmLabel: '创建'
  }
];
