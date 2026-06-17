import { defineSystem } from '../../../../ecs/types';
import { Agent } from '../../agent/components';
import { AgentRun, AgentRunTargetLink } from '../../agentRun/components';
import { Conversation } from '../../chat/components';
import { Mode } from '../../mode/components';
import { ConversationProjectLink, ProjectContext } from '../../project/components';
import { ConversationWorkEnvironmentLink, RunWorkEnvironmentLink, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentBundle, selectRunWorkEnvironment } from '../bundles';
import { activeWorkEnvironmentForRun, linkedWorkEnvironmentForRun } from '../queries';

export const RunWorkEnvironmentSnapshotSystem = defineSystem({
  name: 'RunWorkEnvironmentSnapshotSystem',
  shouldRun({ world }) {
    if (world.query(WorkEnvironment).every((entity) => world.get(entity, WorkEnvironment)?.available !== true)) return false;
    return world.query(AgentRun).some((run) => {
      const linked = linkedWorkEnvironmentForRun(world, run);
      const resolved = activeWorkEnvironmentForRun(world, run);
      return !!resolved && linked?.entity !== resolved.entity;
    });
  },
  access: {
    reads: { components: [Agent, AgentRun, AgentRunTargetLink, Conversation, Mode, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, RunWorkEnvironmentLink, ConversationProjectLink, ProjectContext] },
    bundles: [WorkEnvironmentBundle]
  },
  run({ world, cmd }) {
    for (const run of world.query(AgentRun)) {
      const linked = linkedWorkEnvironmentForRun(world, run);
      const resolved = activeWorkEnvironmentForRun(world, run);
      if (!resolved || linked?.entity === resolved.entity) continue;
      selectRunWorkEnvironment(world, cmd, run, resolved.entity);
    }
  }
});
