import type { Params, SystemDef } from '../core/types';
import { boolParam, numParam } from '../core/types';
import { LifelikeSim, parseRule } from './lifelike-core';
import { PATTERNS, stamp, stampCentered } from './conway-patterns';

// Conway's Game of Life (B3/S23) with a curated pattern library.

export const conwaySystem: SystemDef = {
  id: 'conway',
  name: "Conway's Life",
  tagline: 'The original B3/S23 cellular automaton',
  description:
    "John Conway's Game of Life: every cell lives, dies, or is born from its eight " +
    'neighbours under the rule B3/S23. Despite the trivial rule it is Turing-complete. ' +
    'Load a glider, a Gosper gun, or paint your own soup.',
  category: 'classic',
  brushStates: 2,
  brushColors: ['#0a0e14', '#5ef2c4'],
  params: [
    { kind: 'int', key: 'width', label: 'Width', min: 16, max: 320, step: 1, default: 160 },
    { kind: 'int', key: 'height', label: 'Height', min: 16, max: 240, step: 1, default: 110 },
    { kind: 'bool', key: 'wrap', label: 'Wrap edges (torus)', default: true },
    {
      kind: 'float',
      key: 'density',
      label: 'Random density',
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.32,
      help: 'Fill fraction used by the Random preset / randomize.',
    },
  ],
  presets: [
    { id: 'random', label: 'Random soup' },
    { id: 'glider', label: 'Glider' },
    { id: 'lwss', label: 'Lightweight spaceship' },
    { id: 'gun', label: 'Gosper glider gun' },
    { id: 'pulsar', label: 'Pulsar' },
    { id: 'pentadecathlon', label: 'Pentadecathlon' },
    { id: 'acorn', label: 'Acorn (methuselah)' },
    { id: 'empty', label: 'Empty canvas' },
  ],
  create(params: Params, seed: number, preset?: string) {
    const width = numParam(params, 'width', 160);
    const height = numParam(params, 'height', 110);
    const wrap = boolParam(params, 'wrap', true);
    const density = numParam(params, 'density', 0.32);
    const sim = new LifelikeSim(width, height, parseRule('B3/S23'), wrap);

    switch (preset) {
      case 'empty':
        break;
      case 'glider':
        stamp(sim, PATTERNS.glider, 4, 4);
        break;
      case 'lwss':
        stamp(sim, PATTERNS.lwss, 4, Math.floor(height / 2));
        break;
      case 'gun':
        stamp(sim, PATTERNS.gosperGun, 2, 2);
        break;
      case 'pulsar':
        stampCentered(sim, PATTERNS.pulsar);
        break;
      case 'pentadecathlon':
        stampCentered(sim, PATTERNS.pentadecathlon);
        break;
      case 'acorn':
        stampCentered(sim, PATTERNS.acorn);
        break;
      case 'random':
      default:
        sim.randomFill(seed, density);
        break;
    }
    return sim;
  },
};
