import type { Scheduler } from '../../../../ecs/Scheduler';
import { ConversationModeSelectionSystem } from './ConversationModeSelectionSystem';
import { ModeBuiltinSystem } from './ModeBuiltinSystem';
import { ModeCrudSystem } from './ModeCrudSystem';

export function registerModeSystems(scheduler: Scheduler): void {
  scheduler.add(ModeBuiltinSystem);
  scheduler.add(ModeCrudSystem);
  scheduler.add(ConversationModeSelectionSystem);
}

export { ConversationModeSelectionSystem, ModeBuiltinSystem, ModeCrudSystem };
