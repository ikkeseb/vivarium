import type { Params, SystemDef } from '../core/types';
import { boolParam, numParam, strParam } from '../core/types';
import { LifelikeSim, parseRule } from './lifelike-core';

// The generalized Life-like family: any 2-state outer-totalistic rule in B/S
// notation, on the same engine as Conway. Switch rules live and watch utterly
// different universes emerge from the same eight-neighbour arithmetic.

export const lifeRulesSystem: SystemDef = {
  id: 'life-rules',
  name: 'Life-like Rules',
  tagline: 'Any B/S rule — HighLife, Day & Night, Seeds…',
  description:
    'Outer-totalistic two-state automata defined by birth/survival counts (B/S). ' +
    'Edit the rule directly, or load a famous one: HighLife (B36/S23) has a ' +
    'self-replicating pattern, Day & Night (B3678/S34678) is symmetric under ' +
    'on/off inversion, Seeds (B2/S) explodes, Replicator copies anything.',
  category: 'classic',
  renderKind: 'cells',
  brushStates: 2,
  brushColors: ['#0a0e14', '#5ef2c4'],
  params: [
    {
      kind: 'rule',
      key: 'rule',
      label: 'Rule (B/S)',
      default: 'B36/S23',
      placeholder: 'B36/S23',
      help: 'Birth / Survival neighbour counts.',
    },
    { kind: 'int', key: 'width', label: 'Width', min: 16, max: 320, step: 1, default: 160 },
    { kind: 'int', key: 'height', label: 'Height', min: 16, max: 240, step: 1, default: 110 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges (torus)', default: true },
    { kind: 'float', key: 'density', label: 'Random density', min: 0, max: 1, step: 0.01, default: 0.35 },
  ],
  presets: [
    { id: 'highlife', label: 'HighLife (B36/S23)', params: { rule: 'B36/S23', density: 0.35 } },
    { id: 'daynight', label: 'Day & Night (B3678/S34678)', params: { rule: 'B3678/S34678', density: 0.5 } },
    { id: 'conway', label: 'Conway (B3/S23)', params: { rule: 'B3/S23', density: 0.32 } },
    { id: 'seeds', label: 'Seeds (B2/S)', params: { rule: 'B2/S', density: 0.04 } },
    { id: 'replicator', label: 'Replicator (B1357/S1357)', params: { rule: 'B1357/S1357', density: 0.01 } },
    { id: 'maze', label: 'Maze (B3/S12345)', params: { rule: 'B3/S12345', density: 0.1 } },
    { id: 'mazectric', label: 'Mazectric (B3/S1234)', params: { rule: 'B3/S1234', density: 0.1 } },
    { id: 'twobytwo', label: '2×2 (B36/S125)', params: { rule: 'B36/S125', density: 0.35 } },
    { id: 'coral', label: 'Coral (B3/S45678)', params: { rule: 'B3/S45678', density: 0.4 } },
    { id: 'anneal', label: 'Anneal (B4678/S35678)', params: { rule: 'B4678/S35678', density: 0.5 } },
    { id: 'diamoeba', label: 'Diamoeba (B35678/S5678)', params: { rule: 'B35678/S5678', density: 0.5 } },
    { id: 'walledcities', label: 'Walled Cities (B45678/S2345)', params: { rule: 'B45678/S2345', density: 0.4 } },
  ],
  create(params: Params, seed: number) {
    const width = numParam(params, 'width', 160);
    const height = numParam(params, 'height', 110);
    const wrap = boolParam(params, 'wrap', true);
    const density = numParam(params, 'density', 0.35);
    const rule = strParam(params, 'rule', 'B36/S23');
    const sim = new LifelikeSim(width, height, parseRule(rule), wrap);
    sim.randomFill(seed, density);
    return sim;
  },
};
