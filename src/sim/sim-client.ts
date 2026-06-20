// ─────────────────────────────────────────────────────────────────────────────
// SimClient: the main-thread proxy for the simulation worker. The App talks to
// this instead of holding a `Simulation` directly — it sends commands (create,
// run, step, paint, clear) and reads the latest frame from `mirror`, which the
// renderer draws from. The simulation itself lives entirely in the worker, so a
// heavy step never blocks input, zoom, pan, or the paint cursor.
//
// Cosmetic-only field colormaps are applied here, after transfer, never in the
// worker — keeping them off the determinism boundary entirely.
// ─────────────────────────────────────────────────────────────────────────────

import type { Params, RenderModel } from '../core/types';
import {
  transferBuffersOf,
  type SimCaps,
  type SimFrame,
  type SimRequest,
  type TransferModel,
} from './protocol';

export interface FrameMirror {
  model: RenderModel;
  generation: number;
  hash: string;
  caps: SimCaps;
}

export class SimClient {
  private worker: Worker;
  /** Bumped on every create; frames tagged with a stale epoch are discarded. */
  private epoch = 0;
  private colormap: Uint32Array;
  /** Buffers of the frame currently in `mirror`, returned to the worker on the next frame. */
  private spent: ArrayBuffer[] = [];

  /** The latest accepted frame — the renderer's single source of truth. */
  mirror: FrameMirror | null = null;
  /**
   * Fired whenever a fresh frame is accepted. `fromRun` distinguishes a `run`-tick
   * frame from a paint/step/clear/create one, so the caller can release its run
   * back-pressure guard only when a run actually completes.
   */
  onFrame: ((fromRun: boolean) => void) | null = null;

  constructor(colormap: Uint32Array) {
    this.colormap = colormap;
    this.worker = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent): void => this.handle(e.data as SimFrame);
  }

  /** Swap the live field colormap (cosmetic — applies to the current frame instantly). */
  setColormap(colormap: Uint32Array): void {
    this.colormap = colormap;
    if (this.mirror && this.mirror.model.kind === 'field') {
      this.mirror.model.colormap = colormap;
    }
  }

  create(sysId: string, params: Params, seed: number, preset?: string): void {
    this.epoch++;
    this.post({ type: 'create', epoch: this.epoch, sysId, params: { ...params }, seed, preset });
  }

  run(dt: number, sps: number): void {
    this.post({ type: 'run', dt, sps });
  }

  step(): void {
    this.post({ type: 'step' });
  }

  paint(info: { x: number; y: number; value: number; radius: number }): void {
    this.post({ type: 'paint', info });
  }

  clear(): void {
    this.post({ type: 'clear' });
  }

  private post(req: SimRequest): void {
    this.worker.postMessage(req);
  }

  private handle(frame: SimFrame): void {
    if (frame.epoch !== this.epoch) {
      // A superseded config produced this — return its buffers and drop it.
      this.recycle(transferBuffersOf(frame.model));
      return;
    }
    // Hand last frame's buffers back to the worker's pool before replacing it.
    if (this.spent.length) {
      this.recycle(this.spent);
      this.spent = [];
    }
    this.mirror = {
      model: toRenderModel(frame.model, this.colormap),
      generation: frame.generation,
      hash: frame.hash,
      caps: frame.caps,
    };
    this.spent = transferBuffersOf(frame.model);
    this.onFrame?.(frame.fromRun);
  }

  private recycle(buffers: ArrayBuffer[]): void {
    if (buffers.length) this.worker.postMessage({ type: 'recycle', buffers }, buffers);
  }
}

/** Re-inflate a transferred model to a `RenderModel`, attaching the field colormap. */
function toRenderModel(m: TransferModel, colormap: Uint32Array): RenderModel {
  if (m.kind === 'field') {
    return { kind: 'field', width: m.width, height: m.height, data: m.data, colormap };
  }
  // cells / particles are already exact RenderModel shapes.
  return m;
}
