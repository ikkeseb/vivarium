import { describe, it, expect } from 'vitest';
import { GenerationsSim, parseGenerations, generationsSystem } from '../src/systems/generations';

describe('parseGenerations', () => {
  it("parses Brian's Brain '/2/3'", () => {
    const r = parseGenerations('/2/3');
    expect(r.survive.every((v) => v === false)).toBe(true);
    expect(r.birth[2]).toBe(true);
    expect(r.birth.filter(Boolean).length).toBe(1);
    expect(r.states).toBe(3);
  });

  it("parses Star Wars '345/2/4'", () => {
    const r = parseGenerations('345/2/4');
    expect(r.survive[3]).toBe(true);
    expect(r.survive[4]).toBe(true);
    expect(r.survive[5]).toBe(true);
    expect(r.survive.filter(Boolean).length).toBe(3);
    expect(r.birth[2]).toBe(true);
    expect(r.states).toBe(4);
  });

  it("parses Frogs '12/34/3'", () => {
    const r = parseGenerations('12/34/3');
    expect(r.survive[1]).toBe(true);
    expect(r.survive[2]).toBe(true);
    expect(r.birth[3]).toBe(true);
    expect(r.birth[4]).toBe(true);
    expect(r.states).toBe(3);
  });

  it('clamps the state count to a minimum of 2 when malformed', () => {
    expect(parseGenerations('/2/').states).toBe(2);
    expect(parseGenerations('/2/1').states).toBe(2);
  });
});

describe("Generations — Brian's Brain known outcome", () => {
  it('a single isolated live cell dies out completely after 2 steps', () => {
    const sim = new GenerationsSim(9, 9, parseGenerations('/2/3'), false);
    sim.set(4, 4, 1);
    expect(sim.cells[4 * 9 + 4]).toBe(1);

    // Step 1: cannot survive (S empty) -> becomes dying state 2.
    sim.step();
    expect(sim.cells[4 * 9 + 4]).toBe(2);

    // Step 2: dying state 2 reaches C=3 -> recovers to dead (0). Grid empty.
    sim.step();
    for (let i = 0; i < sim.cells.length; i++) {
      expect(sim.cells[i]).toBe(0);
    }
  });

  it('birth happens for a dead cell with exactly 2 live neighbours', () => {
    // Two adjacent live cells: the dead cells flanking them have 2 live
    // neighbours and should be born next step.
    const sim = new GenerationsSim(9, 9, parseGenerations('/2/3'), false);
    sim.set(3, 4, 1);
    sim.set(5, 4, 1);
    sim.step();
    // Cell (4,4) sits between both live cells -> 2 neighbours -> born.
    expect(sim.cells[4 * 9 + 4]).toBe(1);
    // The original cells could not survive (S empty) -> dying state 2.
    expect(sim.cells[4 * 9 + 3]).toBe(2);
    expect(sim.cells[4 * 9 + 5]).toBe(2);
  });
});

describe('Generations — determinism', () => {
  const run = (seed: number): string => {
    const sim = generationsSystem.create(
      { width: 64, height: 64, wrap: true, density: 0.2, rule: '/2/3' },
      seed,
      'brain',
    );
    for (let i = 0; i < 40; i++) sim.step();
    return sim.hash();
  };

  it('same seed + 40 steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('different seeds diverge', () => {
    expect(run(1)).not.toBe(run(2));
  });
});
