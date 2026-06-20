import type { RenderModel } from '../core/types';
import { rgbaToCss } from '../core/types';

const VOID = '#06080c';

/**
 * Canvas 2D renderer for every render model. Grid/field models are painted into
 * an offscreen ImageData at native cell resolution, then blitted with
 * nearest-neighbour scaling — cheap and crisp. Particle models are drawn as
 * small filled squares grouped by species to minimise state changes.
 */
export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private off: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private buf32: Uint32Array | null = null;

  // Viewport transform from world space to device pixels (set every draw).
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.off = document.createElement('canvas');
    const octx = this.off.getContext('2d', { alpha: false });
    if (!octx) throw new Error('2D canvas context unavailable');
    this.offCtx = octx;
  }

  /** Match the backing store to the element's client size × devicePixelRatio. */
  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private layout(worldW: number, worldH: number): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / worldW, ch / worldH);
    this.scale = s;
    this.ox = Math.floor((cw - worldW * s) / 2);
    this.oy = Math.floor((ch - worldH * s) / 2);
  }

  /** Map a DOM client coordinate to world coordinates using the last layout. */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dprX = this.canvas.width / Math.max(1, rect.width);
    const dprY = this.canvas.height / Math.max(1, rect.height);
    const px = (clientX - rect.left) * dprX;
    const py = (clientY - rect.top) * dprY;
    return {
      x: (px - this.ox) / this.scale,
      y: (py - this.oy) / this.scale,
    };
  }

  private ensureImage(w: number, h: number): void {
    if (!this.img || this.img.width !== w || this.img.height !== h) {
      if (this.off.width !== w) this.off.width = w;
      if (this.off.height !== h) this.off.height = h;
      this.img = this.offCtx.createImageData(w, h);
      this.buf32 = new Uint32Array(this.img.data.buffer);
    }
  }

  draw(model: RenderModel): void {
    this.resize();
    const ctx = this.ctx;
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (model.kind === 'particles') {
      this.drawParticles(model);
      return;
    }

    const { width, height } = model;
    this.ensureImage(width, height);
    const buf = this.buf32!;
    if (model.kind === 'cells') {
      const { data, palette } = model;
      const pn = palette.length;
      for (let i = 0; i < data.length; i++) {
        const s = data[i]!;
        buf[i] = palette[s < pn ? s : 0]!;
      }
    } else {
      const { data, colormap } = model;
      for (let i = 0; i < data.length; i++) {
        let v = data[i]!;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        buf[i] = colormap[(v * 255) | 0]!;
      }
    }
    this.offCtx.putImageData(this.img!, 0, 0);

    this.layout(width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.off,
      0,
      0,
      width,
      height,
      this.ox,
      this.oy,
      width * this.scale,
      height * this.scale,
    );
  }

  private drawParticles(model: Extract<RenderModel, { kind: 'particles' }>): void {
    const ctx = this.ctx;
    this.layout(model.width, model.height);
    const { xs, ys, species, palette, count, radius, background } = model;

    ctx.fillStyle = rgbaToCss(background);
    ctx.fillRect(this.ox, this.oy, model.width * this.scale, model.height * this.scale);

    const r = Math.max(1, radius * this.scale);
    const d = r * 2;
    const ns = palette.length;
    for (let sp = 0; sp < ns; sp++) {
      ctx.fillStyle = rgbaToCss(palette[sp]!);
      for (let i = 0; i < count; i++) {
        if (species[i] !== sp) continue;
        const sx = this.ox + xs[i]! * this.scale;
        const sy = this.oy + ys[i]! * this.scale;
        ctx.fillRect(sx - r, sy - r, d, d);
      }
    }
  }
}
