import type {
  WorkEnvironmentCapabilityKind,
  WorkEnvironmentKind,
  WorkEnvironmentOs,
  WorkEnvironmentRecord,
  WorkEnvironmentSource
} from './protocol';

export const LOCAL_FOLDER_WORK_ENVIRONMENT_KIND = 'localFolder' as const;
export const REMOTE_SERVER_WORK_ENVIRONMENT_KIND = 'remoteServer' as const;

export const WORK_ENVIRONMENT_CAPABILITY = {
  LocalFileRead: 'localFileRead',
  LocalCommand: 'localCommand',
  RemoteFileRead: 'remoteFileRead',
  RemoteCommand: 'remoteCommand',
  ContainerFileRead: 'containerFileRead',
  ContainerCommand: 'containerCommand'
} as const satisfies Record<string, WorkEnvironmentCapabilityKind>;

export type WorkEnvironmentKindCategory = 'local' | 'remote' | 'container' | 'custom';

export interface WorkEnvironmentKindDefinition {
  kind: WorkEnvironmentKind;
  label: string;
  defaultName: string;
  description: string;
  category: WorkEnvironmentKindCategory;
  sortOrder: number;
  systemManaged: boolean;
  editable: boolean;
  removable: boolean;
  creatable: boolean;
  capabilities: WorkEnvironmentCapabilityKind[];
}

export interface LocalFolderWorkEnvironmentInput {
  id?: string;
  name: string;
  uri: string;
  rootPath: string;
  displayPath?: string;
  index?: number;
  available?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface RemoteServerWorkEnvironmentInput {
  id?: string;
  name?: string;
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  password?: string;
  workdir?: string;
  os?: WorkEnvironmentOs;
  description?: string;
  displayPath?: string;
  source?: WorkEnvironmentSource;
  available?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

const BUILTIN_KIND_DEFINITIONS: WorkEnvironmentKindDefinition[] = [
  {
    kind: LOCAL_FOLDER_WORK_ENVIRONMENT_KIND,
    label: '本地',
    defaultName: '本地工作环境',
    description: '由 VS Code workspace folder 自动同步的本地工作目录。',
    category: 'local',
    sortOrder: 0,
    systemManaged: true,
    editable: false,
    removable: false,
    creatable: false,
    capabilities: [WORK_ENVIRONMENT_CAPABILITY.LocalFileRead, WORK_ENVIRONMENT_CAPABILITY.LocalCommand]
  },
  {
    kind: REMOTE_SERVER_WORK_ENVIRONMENT_KIND,
    label: '服务器',
    defaultName: '服务器环境',
    description: '通过 SSH Host/User/IdentityFile/Password 描述的远程服务器环境。',
    category: 'remote',
    sortOrder: 10,
    systemManaged: false,
    editable: true,
    removable: true,
    creatable: true,
    capabilities: []
  }
];

const definitionsByKind = new Map<WorkEnvironmentKind, WorkEnvironmentKindDefinition>(
  BUILTIN_KIND_DEFINITIONS.map((definition) => [definition.kind, definition])
);

export function listBuiltinWorkEnvironmentKindDefinitions(): WorkEnvironmentKindDefinition[] {
  return BUILTIN_KIND_DEFINITIONS.map((definition) => cloneDefinition(definition));
}

export function getWorkEnvironmentKindDefinition(kind: WorkEnvironmentKind | string | undefined): WorkEnvironmentKindDefinition {
  const normalized = normalizeWorkEnvironmentKind(kind, 'custom');
  const builtin = definitionsByKind.get(normalized);
  if (builtin) return cloneDefinition(builtin);
  return {
    kind: normalized,
    label: normalized === 'custom' ? '自定义' : normalized,
    defaultName: normalized === 'custom' ? '自定义工作环境' : `${normalized} 工作环境`,
    description: '由扩展 provider 提供的自定义工作环境。',
    category: 'custom',
    sortOrder: 100,
    systemManaged: false,
    editable: false,
    removable: true,
    creatable: false,
    capabilities: []
  };
}

export function normalizeWorkEnvironmentKind(value: unknown, fallback: WorkEnvironmentKind = LOCAL_FOLDER_WORK_ENVIRONMENT_KIND): WorkEnvironmentKind {
  return typeof value === 'string' && value.trim() ? value.trim() as WorkEnvironmentKind : fallback;
}

export function isLocalFolderWorkEnvironmentKind(kind: WorkEnvironmentKind | string | undefined): boolean {
  return normalizeWorkEnvironmentKind(kind) === LOCAL_FOLDER_WORK_ENVIRONMENT_KIND;
}

export function isRemoteServerWorkEnvironmentKind(kind: WorkEnvironmentKind | string | undefined): boolean {
  return normalizeWorkEnvironmentKind(kind) === REMOTE_SERVER_WORK_ENVIRONMENT_KIND;
}

export function isLocalFolderWorkEnvironment(environment: Pick<WorkEnvironmentRecord, 'kind'> | undefined): boolean {
  return !!environment && isLocalFolderWorkEnvironmentKind(environment.kind);
}

export function isRemoteServerWorkEnvironment(environment: Pick<WorkEnvironmentRecord, 'kind'> | undefined): boolean {
  return !!environment && isRemoteServerWorkEnvironmentKind(environment.kind);
}

export function workEnvironmentKindLabel(kind: WorkEnvironmentKind | string | undefined): string {
  return getWorkEnvironmentKindDefinition(kind).label;
}

export function workEnvironmentDisplayName(environment: Pick<WorkEnvironmentRecord, 'id' | 'kind' | 'name' | 'host'> | undefined): string {
  if (!environment) return '未命名工作环境';
  return normalizeString(environment.name)
    ?? normalizeString(environment.host)
    ?? getWorkEnvironmentKindDefinition(environment.kind).defaultName
    ?? environment.id;
}

export function workEnvironmentDisplayPath(
  environment: Pick<WorkEnvironmentRecord, 'id' | 'kind' | 'name' | 'uri' | 'rootPath' | 'displayPath' | 'host' | 'port' | 'user' | 'workdir'>
): string {
  const explicit = normalizeString(environment.displayPath);
  if (explicit) return explicit;
  if (isRemoteServerWorkEnvironment(environment)) {
    return remoteServerDisplayPath(environment) ?? normalizeString(environment.host) ?? normalizeString(environment.name) ?? environment.id;
  }
  return normalizeString(environment.rootPath)
    ?? normalizeString(environment.uri)
    ?? normalizeString(environment.name)
    ?? environment.id;
}

export function workEnvironmentSortKey(environment: Pick<WorkEnvironmentRecord, 'id' | 'kind' | 'name' | 'host' | 'index'>): string {
  const definition = getWorkEnvironmentKindDefinition(environment.kind);
  const order = String(definition.sortOrder).padStart(4, '0');
  const index = environment.index === undefined ? '999999' : String(environment.index).padStart(6, '0');
  return `${order}:${index}:${workEnvironmentDisplayName(environment)}`;
}

export function canEditWorkEnvironment(environment: Pick<WorkEnvironmentRecord, 'kind'> | undefined): boolean {
  return !!environment && getWorkEnvironmentKindDefinition(environment.kind).editable;
}

export function canRemoveWorkEnvironment(environment: Pick<WorkEnvironmentRecord, 'kind'> | undefined): boolean {
  return !!environment && getWorkEnvironmentKindDefinition(environment.kind).removable;
}

export function workEnvironmentCapabilities(environment: Pick<WorkEnvironmentRecord, 'kind' | 'capabilities'> | undefined): WorkEnvironmentCapabilityKind[] {
  if (!environment) return [];
  const explicit = uniqueStrings(environment.capabilities ?? []);
  return explicit.length > 0 ? explicit : [...getWorkEnvironmentKindDefinition(environment.kind).capabilities];
}

export function workEnvironmentSupportsCapability(
  environment: Pick<WorkEnvironmentRecord, 'kind' | 'capabilities'> | undefined,
  capability: WorkEnvironmentCapabilityKind
): boolean {
  return workEnvironmentCapabilities(environment).includes(capability);
}

export function formatWorkEnvironmentForDisplay(environment: WorkEnvironmentRecord): string {
  const parts = [
    environment.id,
    workEnvironmentDisplayName(environment),
    workEnvironmentKindLabel(environment.kind)
  ];
  const path = workEnvironmentDisplayPath(environment);
  if (path) parts.push(path);
  if (environment.os) parts.push(`os=${environment.os}`);
  if (environment.description) parts.push(environment.description);
  return parts.join(' · ');
}

export function createLocalFolderWorkEnvironmentRecord(input: LocalFolderWorkEnvironmentInput, now = Date.now()): WorkEnvironmentRecord {
  const uri = normalizeString(input.uri) ?? '';
  const rootPath = normalizeString(input.rootPath) ?? uri;
  const id = normalizeString(input.id) ?? workEnvironmentIdFromUri(uri || rootPath || input.name);
  return {
    id,
    kind: LOCAL_FOLDER_WORK_ENVIRONMENT_KIND,
    source: 'workspaceFolder',
    name: normalizeString(input.name) ?? getWorkEnvironmentKindDefinition(LOCAL_FOLDER_WORK_ENVIRONMENT_KIND).defaultName,
    uri,
    rootPath,
    displayPath: normalizeString(input.displayPath) ?? rootPath ?? uri,
    ...(input.index !== undefined ? { index: input.index } : {}),
    available: input.available !== false,
    createdAt: finiteTimestamp(input.createdAt, now),
    updatedAt: finiteTimestamp(input.updatedAt, now)
  };
}

export function createRemoteServerWorkEnvironmentRecord(input: RemoteServerWorkEnvironmentInput, now = Date.now()): WorkEnvironmentRecord {
  const host = normalizeString(input.host) ?? 'server';
  const port = normalizePort(input.port);
  const user = normalizeString(input.user);
  const identityFile = normalizeString(input.identityFile);
  const password = identityFile ? undefined : typeof input.password === 'string' ? input.password : undefined;
  const workdir = normalizeString(input.workdir);
  const displayPath = normalizeString(input.displayPath) ?? remoteServerDisplayPath({ host, port, user, workdir });
  return {
    id: normalizeString(input.id) ?? remoteWorkEnvironmentIdFromHost(host),
    kind: REMOTE_SERVER_WORK_ENVIRONMENT_KIND,
    source: input.source ?? 'manual',
    name: normalizeString(input.name) ?? host,
    host,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(workdir ? { workdir } : {}),
    ...(normalizeString(input.os) ? { os: normalizeString(input.os) } : {}),
    ...(normalizeString(input.description) ? { description: normalizeString(input.description) } : {}),
    ...(displayPath ? { displayPath } : {}),
    available: input.available !== false,
    createdAt: finiteTimestamp(input.createdAt, now),
    updatedAt: finiteTimestamp(input.updatedAt, now)
  };
}

export function remoteServerDisplayPath(input: { user?: string; host?: string; port?: number; workdir?: string }): string | undefined {
  const host = normalizeString(input.host);
  if (!host) return undefined;
  const user = normalizeString(input.user);
  const port = normalizePort(input.port);
  const workdir = normalizeString(input.workdir);
  const userPart = user ? `${user}@` : '';
  const portPart = port && port !== 22 ? `:${port}` : '';
  const dirPart = workdir ? ` ${workdir}` : '';
  return `${userPart}${host}${portPart}${dirPart}`;
}

export function workEnvironmentIdFromUri(uri: string): string {
  return `work-env-local-${shortHash(uri.trim())}`;
}

export function remoteWorkEnvironmentIdFromHost(host: string): string {
  return `work-env-remote-${shortHash(host.trim().toLowerCase())}`;
}

export function workEnvironmentIdForKind(kind: WorkEnvironmentKind | string | undefined, seed: string): string {
  const normalized = normalizeWorkEnvironmentKind(kind, 'custom');
  const prefix = normalized === LOCAL_FOLDER_WORK_ENVIRONMENT_KIND
    ? 'work-env-local'
    : normalized === REMOTE_SERVER_WORK_ENVIRONMENT_KIND
      ? 'work-env-remote'
      : `work-env-${slugifyKind(normalized)}`;
  return `${prefix}-${shortHash(`${normalized}:${seed}`)}`;
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizePort(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : undefined;
  return number !== undefined && Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

export function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

export function uniqueStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const text = normalizeString(value);
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function cloneDefinition(definition: WorkEnvironmentKindDefinition): WorkEnvironmentKindDefinition {
  return { ...definition, capabilities: [...definition.capabilities] };
}

function slugifyKind(kind: WorkEnvironmentKind | string): string {
  const slug = String(kind).trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug || 'custom';
}
