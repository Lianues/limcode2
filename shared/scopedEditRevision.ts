/** 为异步保存/读取请求提供按 scope 单调递增的本地编辑修订号。 */
export class ScopedEditRevision {
  private readonly revisions = new Map<string, number>();

  public current(scopeId: string): number {
    return this.revisions.get(scopeId) ?? 0;
  }

  public next(scopeId: string): number {
    const revision = this.current(scopeId) + 1;
    this.revisions.set(scopeId, revision);
    return revision;
  }

  public isStale(scopeId: string, requestRevision: number | undefined): boolean {
    return requestRevision !== undefined && requestRevision < this.current(scopeId);
  }
}
