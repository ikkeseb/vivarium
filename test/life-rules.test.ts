import { describe, it, expect } from 'vitest';
import { LifelikeSim, parseRule } from '../src/systems/lifelike-core';
import { lifeRulesSystem } from '../src/systems/life-rules';

function liveCells(sim: LifelikeSim): Set<string> {
  const out = new Set<string>();
  const data = sim.cells;
  for (let y = 0; y < sim.height; y++) {
    for (let x = 0; x < sim.width; x++) {
      if (data[y * sim.width + x]) out.add(`${x},${y}`);
    }
  }
  return out;
}

describe('Life-like rules — known outcomes', () => {
  it('Replicator (B1357/S1357): a single cell becomes a hollow 3×3 ring after one step', () => {
    const sim = new LifelikeSim(21, 21, parseRule('B1357/S1357'), false);
    sim.set(10, 10, 1);
    sim.step();
    const live = liveCells(sim);
    // The centre (0 neighbours) dies; its 8 Moore neighbours (1 neighbour each) are born.
    const expected = new Set<string>();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        expected.add(`${10 + dx},${10 + dy}`);
      }
    }
    expect(live).toEqual(expected);
  });

  it('HighLife (B36/S23): a 2×2 block is a still life', () => {
    const sim = new LifelikeSim(20, 20, parseRule('B36/S23'), true);
    sim.set(8, 8, 1);
    sim.set(9, 8, 1);
    sim.set(8, 9, 1);
    sim.set(9, 9, 1);
    const before = liveCells(sim);
    for (let i = 0; i < 10; i++) sim.step();
    expect(liveCells(sim)).toEqual(before);
  });

  it('Seeds (B2/S): every live cell dies each generation (S is empty)', () => {
    const sim = new LifelikeSim(20, 20, parseRule('B2/S'), true);
    sim.set(5, 5, 1);
    sim.set(6, 5, 1);
    sim.set(7, 5, 1);
    sim.step();
    // No cell can survive under B2/S; the original three are all gone.
    expect(sim.cells[5 * 20 + 5]).toBe(0);
    expect(sim.cells[5 * 20 + 6]).toBe(0);
    expect(sim.cells[5 * 20 + 7]).toBe(0);
  });
});

describe('Life-like rules — determinism', () => {
  const run = (seed: number): string => {
    const sim = lifeRulesSystem.create(
      { rule: 'B36/S23', width: 80, height: 60, wrap: true, density: 0.35 },
      seed,
    );
    for (let i = 0; i < 50; i++) sim.step();
    return sim.hash();
  };

  it('same seed reproduces the same hash', () => {
    expect(run(424242)).toBe(run(424242));
  });

  it('different seeds diverge', () => {
    expect(run(7)).not.toBe(run(8));
  });
});
