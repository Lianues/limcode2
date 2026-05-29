import {
  getComponentByName,
  getResourceByName,
  type Entity,
  type WorldCommand,
  type WorldEvent
} from './types';

export type WireWorldCommand =
  | { readonly kind: 'spawn'; readonly entity: Entity }
  | { readonly kind: 'despawn'; readonly entity: Entity }
  | { readonly kind: 'add'; readonly entity: Entity; readonly component: string; readonly value: unknown }
  | { readonly kind: 'remove'; readonly entity: Entity; readonly component: string }
  | { readonly kind: 'setResource'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'enqueue'; readonly event: WorldEvent }
  | { readonly kind: 'effect'; readonly effect: unknown };

export function serializeWorldCommands(commands: readonly WorldCommand[]): WireWorldCommand[] {
  return commands.map((command) => {
    switch (command.kind) {
      case 'spawn':
      case 'despawn':
      case 'enqueue':
      case 'effect':
        return command;
      case 'add':
        return { kind: 'add', entity: command.entity, component: command.component.name, value: command.value };
      case 'remove':
        return { kind: 'remove', entity: command.entity, component: command.component.name };
      case 'setResource':
        return { kind: 'setResource', key: command.key.name, value: command.value };
      default:
        return assertNever(command);
    }
  });
}

export function deserializeWorldCommands(commands: readonly WireWorldCommand[]): WorldCommand[] {
  return commands.map((command) => {
    switch (command.kind) {
      case 'spawn':
      case 'despawn':
      case 'enqueue':
      case 'effect':
        return command;
      case 'add': {
        const component = getComponentByName(command.component);
        if (!component) throw new Error(`Unknown component in worker command: ${command.component}`);
        return { kind: 'add', entity: command.entity, component, value: command.value };
      }
      case 'remove': {
        const component = getComponentByName(command.component);
        if (!component) throw new Error(`Unknown component in worker command: ${command.component}`);
        return { kind: 'remove', entity: command.entity, component };
      }
      case 'setResource': {
        const key = getResourceByName(command.key);
        if (!key) throw new Error(`Unknown resource in worker command: ${command.key}`);
        return { kind: 'setResource', key, value: command.value };
      }
      default:
        return assertNever(command);
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected wire command: ${String(value)}`);
}
