import { describe, it, expect } from 'vitest';
import { WireworldSim, wireworldSystem, stampRing, EMPTY, HEAD, TAIL, COND } from '../src/systems/wireworld';

const at = (sim: WireworldSim, x: number, y: number): number => sim.cells[y * sim.width + x]!;

describe('Wireworld — cell transition rules', () => {
  it('a head becomes a tail, then the tail becomes a conductor', () => {
    const sim = new WireworldSim(5, 5, false);
    sim.set(2, 2, COND);
    sim.set(2, 2, HEAD); // overwrite to a lone head sitting on the wire cell
    sim.step();
    expect(at(sim, 2, 2)).toBe(TAIL);
    sim.step();
    expect(at(sim, 2, 2)).toBe(COND);
  });

  it('empty cells stay empty', () => {
    const sim = new WireworldSim(5, 5, false);
    sim.set(2, 2, HEAD); // a head with no surrounding conductor
    sim.step();
    // Its empty neighbours never light up — empty -> empty regardless.
    expect(at(sim, 1, 2)).toBe(EMPTY);
    expect(at(sim, 3, 2)).toBe(EMPTY);
  });

  it('a conductor with 1 or 2 head neighbours turns into a head', () => {
    const one = new WireworldSim(5, 5, false);
    one.set(2, 2, COND);
    one.set(1, 2, HEAD);
    one.step();
    expect(at(one, 2, 2)).toBe(HEAD);

    const two = new WireworldSim(5, 5, false);
    two.set(2, 2, COND);
    two.set(1, 2, HEAD);
    two.set(3, 2, HEAD);
    two.step();
    expect(at(two, 2, 2)).toBe(HEAD);
  });

  it('a conductor with 3 head neighbours stays a conductor (gate behaviour)', () => {
    const sim = new WireworldSim(5, 5, false);
    sim.set(2, 2, COND);
    sim.set(1, 2, HEAD);
    sim.set(3, 2, HEAD);
    sim.set(2, 1, HEAD);
    sim.step();
    expect(at(sim, 2, 2)).toBe(COND);
  });
});

describe('Wireworld — signal propagation', () => {
  it('an electron moves forward one cell per step and never runs backward', () => {
    // A straight 7-cell wire on row 1, electron (tail,head) at cols 1,2.
    const sim = new WireworldSim(7, 3, false);
    for (let x = 0; x < 7; x++) sim.set(x, 1, COND);
    sim.set(1, 1, TAIL);
    sim.set(2, 1, HEAD);

    sim.step();
    expect(at(sim, 3, 1)).toBe(HEAD); // advanced forward
    expect(at(sim, 2, 1)).toBe(TAIL); // old head is now the tail
    expect(at(sim, 1, 1)).toBe(COND); // old tail relaxed back to wire
    expect(at(sim, 0, 1)).toBe(COND); // never fired backward
  });
});

describe('Wireworld — loop oscillation', () => {
  it('a single electron returns to its start after one full lap', () => {
    // A diagonal-cornered ring (corners empty) has 2w+2h-8 conductor cells, so a
    // w×h ring's electron has that period. 5×5 → 12.
    const w = 5;
    const h = 5;
    const period = 2 * w + 2 * h - 8;
    const sim = new WireworldSim(w, h, false);
    stampRing(sim, 0, 0, w, h, 1);
    // Sanity: the four corners are empty, the rest of the border is wire.
    expect(at(sim, 0, 0)).toBe(EMPTY);
    expect(at(sim, w - 1, 0)).toBe(EMPTY);
    const start = Uint8Array.from(sim.cells);

    for (let i = 0; i < period; i++) sim.step();
    expect(Array.from(sim.cells)).toEqual(Array.from(start));
  });
});

describe('Wireworld — determinism', () => {
  const run = (seed: number): string => {
    const sim = wireworldSystem.create({ width: 64, height: 64, wrap: false }, seed, 'loops');
    for (let i = 0; i < 30; i++) sim.step();
    return sim.hash();
  };

  it('same seed + 30 steps yields the same hash', () => {
    expect(run(20260620)).toBe(run(20260620));
  });

  it('the loops preset evolves away from an empty board', () => {
    const empty = wireworldSystem.create({ width: 64, height: 64, wrap: false }, 1, 'empty');
    for (let i = 0; i < 30; i++) empty.step();
    expect(run(1)).not.toBe(empty.hash());
  });
});
