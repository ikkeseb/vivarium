// ─────────────────────────────────────────────────────────────────────────────
// SimHost: the pure, DOM-free, Worker-free core that owns a live `Simulation`
// and advances it. The worker entry (sim-worker) is a thin shell around this; the
// host itself is synchronous and fully unit-testable in node, so the determinism
// contract is exercised exactly as before — no real Worker needed in tests.
// ─────────────────────────────────────────────────────────────────────────────

import { getSystem } from '../core/registry';
import type { PaintInfo, Params, RenderModel, Simulation } from '../core/types';
import { MAX_STEPS_PER_FRAME, type SimCaps } from './protocol';

export class SimHost {
  private sim: Simulation;
  /** Fractional step carry, so a slow `sps` still advances at the right average rate. */
  private acc = 0;

  constructor(sysId: string, params: Params, seed: number, preset?: string) {
    const sys = getSystem(sysId);
    if (!sys) throw new Error(`SimHost: unknown system "${sysId}"`);
    this.sim = sys.create(params, seed, preset);
  }

  get generation(): number {
    return this.sim.generation;
  }

  hash(): string {
    return this.sim.hash();
  }

  caps(): SimCaps {
    return {
      paint: typeof this.sim.paint === 'function',
      clear: typeof this.sim.clear === 'function',
    };
  }

  render(): RenderModel {
    return this.sim.render();
  }

  stepOnce(): void {
    this.sim.step();
  }

  paint(info: PaintInfo): void {
    this.sim.paint?.(info);
  }

  clear(): boolean {
    if (this.sim.clear) {
      this.sim.clear();
      return true;
    }
    return false;
  }

  /**
   * Advance by a wall-clock delta at `sps` steps/second, accumulating the
   * fractional remainder across calls. `dt` is clamped to 100 ms so a long stall
   * (a backgrounded tab, a heavy create) can never trigger a runaway catch-up;
   * the per-tick step count is capped at `MAX_STEPS_PER_FRAME`. Returns the number
   * of steps actually taken.
   */
  advance(dt: number, sps: number): number {
    const clamped = dt < 0 ? 0 : dt > 0.1 ? 0.1 : dt;
    this.acc += clamped * sps;
    let steps = Math.floor(this.acc);
    if (steps <= 0) return 0;
    this.acc -= steps;
    if (steps > MAX_STEPS_PER_FRAME) steps = MAX_STEPS_PER_FRAME;
    for (let i = 0; i < steps; i++) this.sim.step();
    return steps;
  }
}
