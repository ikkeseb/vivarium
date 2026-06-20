import type { SystemDef } from './types';
import { conwaySystem } from '../systems/conway';
import { lifeRulesSystem } from '../systems/life-rules';
import { generationsSystem } from '../systems/generations';

// The gallery. Systems are registered here in display order.
export const systems: ReadonlyArray<SystemDef> = [conwaySystem, lifeRulesSystem, generationsSystem];

export function getSystem(id: string): SystemDef | undefined {
  return systems.find((s) => s.id === id);
}
