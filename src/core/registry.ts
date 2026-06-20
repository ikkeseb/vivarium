import type { SystemDef } from './types';
import { conwaySystem } from '../systems/conway';
import { lifeRulesSystem } from '../systems/life-rules';
import { generationsSystem } from '../systems/generations';
import { wireworldSystem } from '../systems/wireworld';
import { cyclicSystem } from '../systems/cyclic';
import { elementarySystem } from '../systems/elementary';
import { langtonSystem } from '../systems/langton';
import { leniaSystem } from '../systems/lenia';
import { reactionDiffusionSystem } from '../systems/reaction-diffusion';
import { particleLifeSystem } from '../systems/particle-life';

// The gallery. Systems are registered here in display order.
export const systems: ReadonlyArray<SystemDef> = [
  conwaySystem,
  lifeRulesSystem,
  generationsSystem,
  wireworldSystem,
  cyclicSystem,
  elementarySystem,
  langtonSystem,
  leniaSystem,
  reactionDiffusionSystem,
  particleLifeSystem,
];

export function getSystem(id: string): SystemDef | undefined {
  return systems.find((s) => s.id === id);
}
