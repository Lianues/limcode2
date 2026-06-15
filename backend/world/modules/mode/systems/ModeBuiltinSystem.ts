import { defineSystem } from '../../../../ecs/types';
import { Mode } from '../components';
import { BUILTIN_PLAN_MODE_ID } from '../bundles';

export const ModeBuiltinSystem = defineSystem({
  name: 'ModeBuiltinSystem',
  shouldRun({ world }) {
    return !world.query(Mode).some((entity) => world.get(entity, Mode)?.id === BUILTIN_PLAN_MODE_ID);
  },
  access: {
    reads: { components: [Mode] },
    writes: { components: [Mode], mutationMode: 'create' }
  },
  run({ cmd }) {
    const now = Date.now();
    const mode = cmd.spawn();
    cmd.add(mode, Mode, {
      id: BUILTIN_PLAN_MODE_ID,
      name: 'Plan',
      description: '先规划、分析和拆解任务，再执行后续实现。',
      source: 'builtin',
      icon: 'list-details',
      createdAt: now,
      updatedAt: now
    });
  }
});
