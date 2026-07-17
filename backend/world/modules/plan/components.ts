import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  ConfigScopeBindingRole,
  PlanProposalRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeKind,
  PlanProposalStatus
} from '../../../../shared/protocol';

export type PlanReviewPolicyData = PlanReviewPolicyRecord;
export const PlanReviewPolicy = defineComponent<PlanReviewPolicyData>('PlanReviewPolicy');

export interface PlanReviewPolicyScopeLinkData {
  id: string;
  scopeKind: PlanReviewPolicyScopeKind;
  scopeId?: string;
  planReviewPolicy: Entity;
  workflow?: Entity;
  agent?: Entity;
  conversation?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const PlanReviewPolicyScopeLink = defineComponent<PlanReviewPolicyScopeLinkData>('PlanReviewPolicyScopeLink');

export type PlanProposalData = PlanProposalRecord;
export const PlanProposal = defineComponent<PlanProposalData>('PlanProposal');

export interface RunPlanProposalLinkData {
  id: string;
  run: Entity;
  planProposal: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunPlanProposalLink = defineComponent<RunPlanProposalLinkData>('RunPlanProposalLink');

export function isFinalPlanProposalStatus(status: PlanProposalStatus): boolean {
  return status === 'approved' || status === 'change_requested' || status === 'rejected';
}
