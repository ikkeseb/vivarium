// Seedable, deterministic PRNG. mulberry32 is tiny, fast, and produces a stable
// stream for a given 32-bit seed across platforms — exactly what determinism
// tests need.

export type Rng = () => number;

/** Returns a function yielding floats in [0, 1) for the given seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, maxExclusive). */
export function randInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

/** Float in [lo, hi). */
export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Standard-normal sample via Box–Muller (deterministic given the rng). */
export function randNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Pick a random element. Returns undefined only for empty input. */
export function pick<T>(rng: Rng, arr: ReadonlyArray<T>): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[randInt(rng, arr.length)];
}
