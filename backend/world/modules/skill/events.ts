import type { SkillPolicyScopeClearPayload, SkillPolicyScopeSetPayload } from '../../../../shared/protocol';

export const SkillEventType = {
  PolicyScopeSetRequested: 'skill:policyScopeSetRequested',
  PolicyScopeClearRequested: 'skill:policyScopeClearRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'skill:policyScopeSetRequested': SkillPolicyScopeSetPayload;
    'skill:policyScopeClearRequested': SkillPolicyScopeClearPayload;
  }
}
