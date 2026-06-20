import type { LifelikeSim } from './lifelike-core';

// A small, hand-verified pattern library for Conway's Game of Life. Patterns are
// stored as ASCII art ('O' = live) and parsed to relative cell coordinates.

export interface Pattern {
  cells: ReadonlyArray<readonly [number, number]>;
  width: number;
  height: number;
}

function fromAscii(rows: string[]): Pattern {
  const cells: Array<[number, number]> = [];
  let width = 0;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    width = Math.max(width, row.length);
    for (let x = 0; x < row.length; x++) {
      const c = row[x]!;
      if (c === 'O' || c === '#' || c === '*') cells.push([x, y]);
    }
  }
  return { cells, width, height: rows.length };
}

function fromCoords(coords: ReadonlyArray<readonly [number, number]>): Pattern {
  let width = 0;
  let height = 0;
  for (const [x, y] of coords) {
    width = Math.max(width, x + 1);
    height = Math.max(height, y + 1);
  }
  return { cells: coords, width, height };
}

export const PATTERNS = {
  block: fromAscii(['OO', 'OO']),
  beehive: fromAscii(['.OO.', 'O..O', '.OO.']),
  loaf: fromAscii(['.OO.', 'O..O', '.O.O', '..O.']),
  blinker: fromAscii(['OOO']),
  toad: fromAscii(['.OOO', 'OOO.']),
  beacon: fromAscii(['OO..', 'OO..', '..OO', '..OO']),
  glider: fromAscii(['.O.', '..O', 'OOO']),
  lwss: fromAscii(['.O..O', 'O....', 'O...O', 'OOOO.']),
  mwss: fromAscii(['..O..O', 'O.....', 'O....O', 'OOOOO.']),
  hwss: fromAscii(['..OO..O', 'O......', 'O.....O', 'OOOOOO.']),
  pulsar: fromAscii([
    '..OOO...OOO..',
    '.............',
    'O....O.O....O',
    'O....O.O....O',
    'O....O.O....O',
    '..OOO...OOO..',
    '.............',
    '..OOO...OOO..',
    'O....O.O....O',
    'O....O.O....O',
    'O....O.O....O',
    '.............',
    '..OOO...OOO..',
  ]),
  pentadecathlon: fromAscii(['..O....O..', 'OO.OOOO.OO', '..O....O..']),
  rPentomino: fromAscii(['.OO', 'OO.', '.O.']),
  acorn: fromAscii(['.O.....', '...O...', 'OO..OOO']),
  diehard: fromAscii(['......O.', 'OO......', '.O...OOO']),
  gosperGun: fromCoords([
    [0, 4], [0, 5], [1, 4], [1, 5],
    [10, 4], [10, 5], [10, 6], [11, 3], [11, 7], [12, 2], [12, 8], [13, 2], [13, 8],
    [14, 5], [15, 3], [15, 7], [16, 4], [16, 5], [16, 6], [17, 5],
    [20, 2], [20, 3], [20, 4], [21, 2], [21, 3], [21, 4], [22, 1], [22, 5],
    [24, 0], [24, 1], [24, 5], [24, 6],
    [34, 2], [34, 3], [35, 2], [35, 3],
  ]),
} as const satisfies Record<string, Pattern>;

export type PatternName = keyof typeof PATTERNS;

/** Stamp a pattern with its top-left at (ox, oy). */
export function stamp(sim: LifelikeSim, pattern: Pattern, ox: number, oy: number): void {
  for (const [x, y] of pattern.cells) sim.set(ox + x, oy + y, 1);
}

/** Stamp a pattern centred in the grid. */
export function stampCentered(sim: LifelikeSim, pattern: Pattern): void {
  const ox = Math.floor((sim.width - pattern.width) / 2);
  const oy = Math.floor((sim.height - pattern.height) / 2);
  stamp(sim, pattern, ox, oy);
}
