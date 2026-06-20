// ─────────────────────────────────────────────────────────────────────────────
// Gallery thumbnails. Each system gets a tiny, deterministic snapshot: build a
// small simulation, evolve it just enough to look characteristic, and snapshot
// one frame to a PNG data URL. Generated once and cached; computed off the first
// paint so the gallery appears instantly and the previews fade in after.
// ─────────────────────────────────────────────────────────────────────────────

import type { SystemDef } from '../core/types';
import { paramsForPreset } from '../core/types';
import { modelToPNG } from '../render/renderer';

/** Fixed seed → every visitor sees the same gallery. */
const THUMB_SEED = 3;
/** Cap grid dimensions for cheap thumbnail simulations (particles keep theirs). */
const THUMB_DIM = 64;

/** Steps to evolve each system so its thumbnail reads as itself, not noise. */
function thumbSteps(sys: SystemDef, simHeight: number): number {
  switch (sys.id) {
    case 'elementary':
      return Math.max(1, simHeight - 1); // fill the triangle row by row
    case 'langton':
      return 1800; // long enough for the highway to emerge
    case 'reaction-diffusion':
      return 800;
    case 'lenia':
      return 60;
    case 'cyclic':
      return 90; // spirals need time to wind up
    case 'particle-life':
      return 250;
    default:
      break;
  }
  switch (sys.category) {
    case 'classic':
      return 36;
    case 'continuous':
      return 80;
    case 'particles':
      return 220;
    case 'agent':
      return 1500;
    case '1d':
      return Math.max(1, simHeight - 1);
    default:
      return 50;
  }
}

/**
 * Per-system tuning so the dull defaults (Lenia's soup dies; RD mitosis is
 * sparse at thumbnail scale) become eye-catching previews. `dim` overrides the
 * grid cap; a larger Lenia grid keeps its big R=13 kernel in proportion.
 */
interface ThumbOverride {
  preset?: string;
  steps?: number;
  dim?: number;
  params?: Record<string, number>;
}
const OVERRIDES: Record<string, ThumbOverride> = {
  'reaction-diffusion': { preset: 'coral', steps: 1200 },
  lenia: { dim: 96, steps: 55, params: { density: 0.5 } },
};

export function makeThumbnail(sys: SystemDef, targetPx = 128): string {
  const ov = OVERRIDES[sys.id] ?? {};
  const presetId = ov.preset ?? sys.presets?.[0]?.id;
  const params = paramsForPreset(sys, presetId);
  if (ov.params) for (const [k, v] of Object.entries(ov.params)) params[k] = v;
  const cap = ov.dim ?? THUMB_DIM;
  if (sys.category !== 'particles') {
    if (typeof params.width === 'number') params.width = Math.min(params.width, cap);
    if (typeof params.height === 'number') params.height = Math.min(params.height, cap);
  }
  try {
    const sim = sys.create(params, THUMB_SEED, presetId);
    const steps = ov.steps ?? thumbSteps(sys, sim.height);
    for (let i = 0; i < steps; i++) sim.step();
    return modelToPNG(sim.render(), targetPx);
  } catch {
    return ''; // a misbehaving system simply gets no thumbnail
  }
}
