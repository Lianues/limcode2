import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  CompressionBlockRecord,
  CompressionBlockLlmInvocationLinkRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord,
  RunCompressionBlockLinkRecord
} from '../../../../shared/protocol';

export type CompressionBlockData = Omit<CompressionBlockRecord, 'conversationId'> & { conversation: Entity };
export const CompressionBlock = defineComponent<CompressionBlockData>('CompressionBlock');

export type CompressionBlockSourceLinkData = Omit<CompressionBlockSourceLinkRecord, 'blockId'> & { block: Entity; source?: Entity };
export const CompressionBlockSourceLink = defineComponent<CompressionBlockSourceLinkData>('CompressionBlockSourceLink');

export type CompressionContextVariantData = Omit<CompressionContextVariantRecord, 'blockId'> & { block: Entity };
export const CompressionContextVariant = defineComponent<CompressionContextVariantData>('CompressionContextVariant');

export type RunCompressionBlockLinkData = Omit<RunCompressionBlockLinkRecord, 'runId' | 'blockId'> & { run: Entity; block: Entity; variant?: Entity };
export const RunCompressionBlockLink = defineComponent<RunCompressionBlockLinkData>('RunCompressionBlockLink');

export type CompressionBlockLlmInvocationLinkData = Omit<CompressionBlockLlmInvocationLinkRecord, 'blockId' | 'invocationId'> & { block: Entity; invocation: Entity };
export const CompressionBlockLlmInvocationLink = defineComponent<CompressionBlockLlmInvocationLinkData>('CompressionBlockLlmInvocationLink');
