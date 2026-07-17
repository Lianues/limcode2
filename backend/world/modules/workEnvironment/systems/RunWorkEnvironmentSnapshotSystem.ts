import { defineSystem } from '../../../../ecs/types';
import { Agent } from '../../agent/components';
import { AgentRun, AgentRunTargetLink } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Workflow } from '../../workflow/components';
import { ConversationProjectLink, ProjectContext } from '../../project/components';
import { ConversationWorkEnvironmentLink, RunWorkEnvironmentLink, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentBundle, selectRunWorkEnvironment } from '../bundles';
import { activeWorkEnvironmentForRun, effectiveWorkEnvironmentPolicyForRun, linkedWorkEnvironmentForRun } from '../queries';

export const RunWorkEnvironmentSnapshotSystem = defineSystem({
  name: 'RunWorkEnvironmentSnapshotSystem',
  shouldRun({ world }) {
    if (world.query(WorkEnvironment).every((entity) => world.get(entity, WorkEnvironment)?.available !== true)) return false;
    return world.query(AgentRun).some((run) => {
      if (effectiveWorkEnvironmentPolicyForRun(world, run).policy?.enabled !== true) return false;
      const linked = linkedWorkEnvironmentForRun(world, run);
      const resolved = activeWorkEnvironmentForRun(world, run);
      return !!resolved && linked?.entity !== resolved.entity;
    });
  },
  access: {
    reads: { components: [Agent, AgentRun, AgentRunTargetLink, Conversation, Workflow, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, RunWorkEnvironmentLink, ConversationProjectLink, ProjectContext] },
    bundles: [WorkEnvironmentBundle]
  },
  run({ world, cmd }) {
    for (const run of world.query(AgentRun)) {
      if (effectiveWorkEnvironmentPolicyForRun(world, run).policy?.enabled !== true) continue;
      const linked = linkedWorkEnvironmentForRun(world, run);
      const resolved = activeWorkEnvironmentForRun(world, run);
      if (!resolved || linked?.entity === resolved.entity) continue;
      selectRunWorkEnvironment(world, cmd, run, resolved.entity);
    }
  }
});
