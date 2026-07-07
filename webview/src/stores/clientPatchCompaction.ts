import type { ClientPatchOp } from '@shared/protocol';

type MessageStatusPatch = Extract<ClientPatchOp, { kind: 'message.status' }>;
type MessagePartTextAppendPatch = Extract<ClientPatchOp, { kind: 'message.partText.append' }>;
type MessagePartThoughtElapsedPatch = Extract<ClientPatchOp, { kind: 'message.partThoughtElapsed.set' }>;
type MessagePartInsertPatch = Extract<ClientPatchOp, { kind: 'message.part.insert' }>;

type CompactableMessagePatch = MessageStatusPatch | MessagePartTextAppendPatch | MessagePartThoughtElapsedPatch;

/**
 * 合并同一批流式消息 patch，降低 Webview 单帧内的响应式写入次数。
 *
 * 只合并对最终状态等价的 mutation：
 * - 文本 append：同一 message/partIndex 按顺序拼接 delta；
 * - 思考耗时：同一 message/partIndex 只保留后端发来的最后一个 elapsedMs；
 * - 消息状态：同一 message 只保留最后一个 status。
 *
 * message.part.insert / upsert / remove 等结构性 patch 是顺序屏障；遇到屏障会先 flush 已合并 mutation，
 * 再原样输出屏障 patch，避免 partIndex 语义被改变。
 */
export function compactClientPatchOps(patches: readonly ClientPatchOp[]): ClientPatchOp[] {
  if (patches.length <= 1) return [...patches];

  const result: ClientPatchOp[] = [];
  let pending: CompactableMessagePatch[] = [];
  const pendingByKey = new Map<string, CompactableMessagePatch>();

  const flushPending = (): void => {
    if (pending.length === 0) return;
    result.push(...pending);
    pending = [];
    pendingByKey.clear();
  };

  for (const patch of patches) {
    if (patch.kind === 'message.partText.append') {
      const key = `append:${patch.id}:${patch.partIndex}`;
      const existing = pendingByKey.get(key);
      if (existing?.kind === 'message.partText.append') {
        existing.delta += patch.delta;
      } else {
        const next: MessagePartTextAppendPatch = { ...patch };
        pending.push(next);
        pendingByKey.set(key, next);
      }
      continue;
    }

    if (patch.kind === 'message.partThoughtElapsed.set') {
      const key = `thoughtElapsed:${patch.id}:${patch.partIndex}`;
      const existing = pendingByKey.get(key);
      if (existing?.kind === 'message.partThoughtElapsed.set') {
        existing.elapsedMs = patch.elapsedMs;
      } else {
        const next: MessagePartThoughtElapsedPatch = { ...patch };
        pending.push(next);
        pendingByKey.set(key, next);
      }
      continue;
    }

    if (patch.kind === 'message.status') {
      const key = `status:${patch.id}`;
      const existing = pendingByKey.get(key);
      if (existing?.kind === 'message.status') {
        existing.status = patch.status;
      } else {
        const next: MessageStatusPatch = { ...patch };
        pending.push(next);
        pendingByKey.set(key, next);
      }
      continue;
    }

    flushPending();
    result.push(patch);
  }

  flushPending();
  return result;
}

/** 这些 patch 只改消息内容/状态，不会改变消息是否属于当前 timeline window。 */
export function isTimelineWindowStablePatch(patch: ClientPatchOp): patch is CompactableMessagePatch | MessagePartInsertPatch {
  return patch.kind === 'message.partText.append' ||
    patch.kind === 'message.partThoughtElapsed.set' ||
    patch.kind === 'message.part.insert' ||
    patch.kind === 'message.status';
}

export function areTimelineWindowStablePatches(patches: readonly ClientPatchOp[]): boolean {
  return patches.length > 0 && patches.every(isTimelineWindowStablePatch);
}
