export interface ConversationAttentionRequest {
  conversationId: string;
}

/**
 * 同一 Conversation 连续等待期间只返回一次提醒；当该 Conversation 不再等待后，
 * 下一轮新的等待可以再次提醒。ask_user 与 Plan 审批共用这套去重语义。
 */
export class ConversationAttentionTracker<TRequest extends ConversationAttentionRequest> {
  private readonly activeConversationIds = new Set<string>();

  public takeNew(requests: readonly TRequest[]): TRequest[] {
    const pendingConversationIds = new Set(requests.map((request) => request.conversationId));
    for (const conversationId of this.activeConversationIds) {
      if (!pendingConversationIds.has(conversationId)) this.activeConversationIds.delete(conversationId);
    }

    const newlyPending: TRequest[] = [];
    for (const request of requests) {
      if (!this.activeConversationIds.has(request.conversationId)) newlyPending.push(request);
      this.activeConversationIds.add(request.conversationId);
    }
    return newlyPending;
  }

  public clear(): void {
    this.activeConversationIds.clear();
  }
}

export function compactAttentionText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}
