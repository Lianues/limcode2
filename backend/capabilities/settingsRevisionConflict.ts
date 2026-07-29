/**
 * 设置写入的乐观并发冲突（optimistic concurrency conflict）。
 *
 * 多窗口同时打开设置面板时，B 窗口手里的列表可能早于 A 窗口刚保存的结果。
 * 存储层的全量保存会把「B 的旧列表」当成权威，从而静默删掉 A 新增的记录——
 * 这类丢失靠文件锁是防不住的，只能靠写入前的版本比对拒绝过期提交。
 */
export const SETTINGS_REVISION_CONFLICT_NAME = 'SettingsRevisionConflictError';

export class SettingsRevisionConflictError extends Error {
  /** 跨模块实例（bundle 拆分/重复加载）也能安全识别的标记。 */
  public readonly settingsRevisionConflict = true;

  public constructor(
    public readonly section: string,
    public readonly expectedRevision?: string,
    public readonly actualRevision?: string
  ) {
    super(`设置「${section}」已在其他窗口修改，本次保存已被拒绝以避免覆盖。已为你载入最新值，请重新修改。`);
    this.name = SETTINGS_REVISION_CONFLICT_NAME;
  }
}

export function isSettingsRevisionConflictError(error: unknown): error is SettingsRevisionConflictError {
  if (error instanceof SettingsRevisionConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { settingsRevisionConflict?: unknown; name?: unknown };
  return candidate.settingsRevisionConflict === true || candidate.name === SETTINGS_REVISION_CONFLICT_NAME;
}
