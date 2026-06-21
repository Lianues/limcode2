import type {
  ClientState,
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord,
  RunCompressionBlockLinkRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { CompressionBlock, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink } from './components';

export const compressionStateProjectionReads: AccessDeclaration = {
  components: [Conversation, AgentRun, CompressionBlock, CompressionBlockSourceLink, CompressionContextVariant, RunCompressionBlockLink]
};

export function projectCompressionState(world: WorldReader): Partial<ClientState> {
  return {
    compressionBlocks: world.query(CompressionBlock).map((entity) => buildBlockRecord(world, entity)).filter(isDefined),
    compressionBlockSourceLinks: world.query(CompressionBlockSourceLink).map((entity) => buildSourceLinkRecord(world, entity)).filter(isDefined),
    compressionContextVariants: world.query(CompressionContextVariant).map((entity) => buildVariantRecord(world, entity)).filter(isDefined),
    runCompressionBlockLinks: world.query(RunCompressionBlockLink).map((entity) => buildRunLinkRecord(world, entity)).filter(isDefined)
  };
}

function buildBlockRecord(world: WorldReader, entity: number): CompressionBlockRecord | undefined {
  const block = world.get(entity, CompressionBlock);
  if (!block) return undefined;
  const conversation = world.get(block.conversation, Conversation);
  if (!conversation) return undefined;
  const { conversation: _conversation, ...rest } = block;
  return { ...rest, conversationId: conversation.id };
}

function buildSourceLinkRecord(world: WorldReader, entity: number): CompressionBlockSourceLinkRecord | undefined {
  const link = world.get(entity, CompressionBlockSourceLink);
  if (!link) return undefined;
  const block = world.get(link.block, CompressionBlock);
  if (!block) return undefined;
  const { block: _block, source: _source, ...rest } = link;
  return { ...rest, blockId: block.id };
}

function buildVariantRecord(world: WorldReader, entity: number): CompressionContextVariantRecord | undefined {
  const variant = world.get(entity, CompressionContextVariant);
  if (!variant) return undefined;
  const block = world.get(variant.block, CompressionBlock);
  if (!block) return undefined;
  const { block: _block, ...rest } = variant;
  return { ...rest, blockId: block.id };
}

function buildRunLinkRecord(world: WorldReader, entity: number): RunCompressionBlockLinkRecord | undefined {
  const link = world.get(entity, RunCompressionBlockLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const block = world.get(link.block, CompressionBlock);
  const variant = link.variant !== undefined ? world.get(link.variant, CompressionContextVariant) : undefined;
  if (!run || !block) return undefined;
  const { run: _run, block: _block, variant: _variant, ...rest } = link;
  return { ...rest, runId: run.id, blockId: block.id, ...(variant ? { variantId: variant.id } : {}) };
}

function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
