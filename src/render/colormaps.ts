// ─────────────────────────────────────────────────────────────────────────────
// Named colour lookup tables for field (continuous) systems.
//
// A FieldModel renders its [0,1] scalar through a 256-entry RGBA LUT. The choice
// of LUT is purely cosmetic — it never touches simulation state, so it is kept
// out of `hash()` and out of the deterministic parameter schema. Systems carry
// the default ("teal") so they render correctly standalone (tests, thumbnails);
// the UI may swap the live model's `colormap` to any entry here.
// ─────────────────────────────────────────────────────────────────────────────

import { rgba } from '../core/types';

export interface Colormap {
  id: string;
  label: string;
  lut: Uint32Array; // 256 packed-RGBA entries, indexed by round(v*255)
}

interface Stop {
  t: number;
  r: number;
  g: number;
  b: number;
}

/** Build a 256-entry LUT by linearly interpolating an ordered list of stops. */
function ramp(stops: Stop[]): Uint32Array {
  const cm = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let lo = stops[0]!;
    let hi = stops[stops.length - 1]!;
    for (let s = 0; s < stops.length - 1; s++) {
      const a = stops[s]!;
      const b = stops[s + 1]!;
      if (v >= a.t && v <= b.t) {
        lo = a;
        hi = b;
        break;
      }
    }
    const span = hi.t - lo.t || 1;
    const f = (v - lo.t) / span;
    const r = Math.round(lo.r + (hi.r - lo.r) * f);
    const g = Math.round(lo.g + (hi.g - lo.g) * f);
    const b = Math.round(lo.b + (hi.b - lo.b) * f);
    cm[i] = rgba(r, g, b);
  }
  return cm;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >>> 16) & 0xff, g: (n >>> 8) & 0xff, b: n & 0xff };
}

/** Evenly space a list of hex colours into stops at t = 0 .. 1. */
function evenStops(hexes: string[]): Stop[] {
  const n = hexes.length;
  return hexes.map((h, i) => ({ t: n === 1 ? 0 : i / (n - 1), ...hexToRgb(h) }));
}

// The original vivarium ramp: near-black void → deep teal → mint → near-white.
// Kept byte-identical to the colour that lenia / reaction–diffusion shipped with.
const TEAL_STOPS: Stop[] = [
  { t: 0.0, r: 6, g: 9, b: 14 },
  { t: 0.35, r: 14, g: 64, b: 82 },
  { t: 0.7, r: 60, g: 200, b: 168 },
  { t: 1.0, r: 232, g: 255, b: 244 },
];

export const COLORMAPS: ReadonlyArray<Colormap> = [
  { id: 'teal', label: 'Teal (default)', lut: ramp(TEAL_STOPS) },
  { id: 'viridis', label: 'Viridis', lut: ramp(evenStops(['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'])) },
  { id: 'inferno', label: 'Inferno', lut: ramp(evenStops(['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'])) },
  { id: 'magma', label: 'Magma', lut: ramp(evenStops(['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'])) },
  { id: 'plasma', label: 'Plasma', lut: ramp(evenStops(['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636', '#f0f921'])) },
  { id: 'grayscale', label: 'Grayscale', lut: ramp(evenStops(['#06080c', '#ffffff'])) },
];

export const DEFAULT_COLORMAP_ID = 'teal';

/** The default ("teal") LUT — what field systems carry when none is chosen. */
export const DEFAULT_COLORMAP: Uint32Array = COLORMAPS[0]!.lut;

/** True if `id` names a known colormap. */
export function isColormapId(id: string): boolean {
  return COLORMAPS.some((c) => c.id === id);
}

/** Resolve a colormap id to its LUT, falling back to the default when unknown. */
export function colormapLut(id: string | undefined): Uint32Array {
  if (!id) return DEFAULT_COLORMAP;
  const found = COLORMAPS.find((c) => c.id === id);
  return found ? found.lut : DEFAULT_COLORMAP;
}
