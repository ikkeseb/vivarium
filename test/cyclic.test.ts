import { describe, it, expect } from 'vitest';
import { CyclicSim, buildOffsets, stepGrid, cyclicSystem } from '../src/systems/cyclic';

describe('Cyclic CA — neighbourhood offsets', () => {
  it('Moore range 1 is the full 8-cell box (centre excluded)', () => {
    expect(buildOffsets('moore', 1)).toHaveLength(8);
  });
  it('von Neumann range 1 is the 4 orthogonal neighbours', () => {
    expect(buildOffsets('neumann', 1)).toHaveLength(4);
  });
  it('Moore range 2 covers the 24-cell box', () => {
    expect(buildOffsets('moore', 2)).toHaveLength(24);
  });
  it('von Neumann range 2 is the 12-cell diamond', () => {
    expect(buildOffsets('neumann', 2)).toHaveLength(12);
  });
});

describe('Cyclic CA — transition rule', () => {
  it('a cell advances when threshold successor-neighbours are present', () => {
    // 1x3 strip, 3 states, threshold 1, von Neumann r=1, no wrap.
    // Centre is state 0; its right neighbour is state 1 (the successor) so it advances.
    const W = 3;
    const H = 1;
    const src = new Uint8Array([0, 0, 1]);
    const dst = new Uint8Array(W * H);
    stepGrid(src, dst, W, H, 3, 1, buildOffsets('neumann', 1), false);
    // Cell 1 sees one neighbour (cell 2) in successor state 1 → advances to 1.
    expect(dst[1]).toBe(1);
    // Cell 2 (state 1) needs a neighbour in state 2; none → stays 1.
    expect(dst[2]).toBe(1);
    // Cell 0 (state 0) successor is 1; neighbour cell 1 is state 0 → stays 0.
    expect(dst[0]).toBe(0);
  });

  it('respects the threshold (needs >= threshold successor neighbours)', () => {
    // Centre state 0, threshold 2, only one neighbour in successor state 1 → no advance.
    const W = 3;
    const H = 1;
    const src = new Uint8Array([1, 0, 0]);
    const dst = new Uint8Array(W * H);
    stepGrid(src, dst, W, H, 3, 2, buildOffsets('neumann', 1), false);
    expect(dst[1]).toBe(0); // only one successor neighbour, threshold 2 → unchanged
  });
});

describe('Cyclic CA — homogeneous fixed point (known outcome)', () => {
  it('an all-zero grid never changes; generation tracks steps', () => {
    const sim = cyclicSystem.create(
      { states: 12, threshold: 1, range: 1, neighborhood: 'moore', width: 40, height: 30, wrap: true },
      12345,
    ) as CyclicSim;
    // Force the homogeneous quiescent state — do NOT random fill for this test.
    sim.clear();
    for (let i = 0; i < 10; i++) sim.step();
    const cells = sim.cells;
    let allZero = true;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== 0) {
        allZero = false;
        break;
      }
    }
    expect(allZero).toBe(true);
    expect(sim.generation).toBe(10);
  });
});

describe('Cyclic CA — determinism', () => {
  const run = (seed: number): string => {
    const sim = cyclicSystem.create(
      { states: 12, threshold: 1, range: 1, neighborhood: 'moore', width: 60, height: 40, wrap: true },
      seed,
      'random',
    ) as CyclicSim;
    for (let i = 0; i < 30; i++) sim.step();
    return sim.hash();
  };

  it('same seed + steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });
});
