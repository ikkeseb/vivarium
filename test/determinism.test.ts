import { describe, it, expect } from 'vitest';
import { systems } from '../src/core/registry';
import { defaultParams } from '../src/core/types';

// Registry-level determinism guarantee: EVERY registered system must be
// reproducible from a seed, and its state hash after a fixed number of steps is
// pinned as a snapshot (seed + N steps -> grid hash). This catches any future
// system that accidentally introduces non-determinism (e.g. Math.random).

const SEED = 12345;
const STEPS = 25;

describe('determinism — every registered system', () => {
  for (const sys of systems) {
    const preset = sys.presets?.[0]?.id;

    it(`${sys.id}: same seed + ${STEPS} steps => identical hash`, () => {
      const build = () => sys.create(defaultParams(sys.params), SEED, preset);
      const a = build();
      const b = build();
      for (let i = 0; i < STEPS; i++) {
        a.step();
        b.step();
      }
      expect(a.hash()).toBe(b.hash());
      expect(a.generation).toBe(STEPS);
    });

    it(`${sys.id}: grid hash after ${STEPS} steps is pinned`, () => {
      const sim = sys.create(defaultParams(sys.params), SEED, preset);
      for (let i = 0; i < STEPS; i++) sim.step();
      expect(sim.hash()).toMatchSnapshot();
    });
  }
});
