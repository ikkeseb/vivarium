import type { CellsModel, FieldModel, ParticlesModel, RenderModel } from '../core/types';
import { rgbaToCss } from '../core/types';

const VOID = '#06080c';
const MIN_ZOOM = 1;
const MAX_ZOOM = 48;
/** Keep at least this many device px of the world on screen when panning. */
const PAN_MARGIN = 64;

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

  // User view: a zoom multiplier on top of fit-to-view, plus a pan in device px.
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private worldW = 1;
  private worldH = 1;

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
    this.worldW = worldW;
    this.worldH = worldH;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / worldW, ch / worldH) * this.zoom;
    this.scale = s;
    this.ox = Math.floor((cw - worldW * s) / 2 + this.panX);
    this.oy = Math.floor((ch - worldH * s) / 2 + this.panY);
  }

  // ── View controls (zoom / pan) ─────────────────────────────────────────────
  // The view transform is purely cosmetic — it never touches simulation state,
  // so determinism is unaffected. screenToWorld already inverts ox/oy/scale, so
  // painting keeps landing on the right cell at any zoom.

  /** Multiply the zoom toward a client-space anchor, keeping that point fixed. */
  zoomAt(clientX: number, clientY: number, factor: number): void {
    const z = clampn(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom) return;
    const rect = this.canvas.getBoundingClientRect();
    const cx = (clientX - rect.left) * (this.canvas.width / Math.max(1, rect.width));
    const cy = (clientY - rect.top) * (this.canvas.height / Math.max(1, rect.height));
    const wx = (cx - this.ox) / this.scale;
    const wy = (cy - this.oy) / this.scale;
    this.zoom = z;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / this.worldW, ch / this.worldH) * z;
    this.panX = cx - wx * s - (cw - this.worldW * s) / 2;
    this.panY = cy - wy * s - (ch - this.worldH * s) / 2;
    this.clampPan();
  }

  /** Pan by a client-space (CSS px) delta. */
  panBy(clientDx: number, clientDy: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.panX += clientDx * (this.canvas.width / Math.max(1, rect.width));
    this.panY += clientDy * (this.canvas.height / Math.max(1, rect.height));
    this.clampPan();
  }

  /** Reset to fit-to-view. */
  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  private clampPan(): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s = Math.min(cw / this.worldW, ch / this.worldH) * this.zoom;
    const ww = this.worldW * s;
    const wh = this.worldH * s;
    const ox = (cw - ww) / 2 + this.panX;
    const oy = (ch - wh) / 2 + this.panY;
    const mx = Math.min(ww, PAN_MARGIN);
    const my = Math.min(wh, PAN_MARGIN);
    const clampedOx = Math.max(-ww + mx, Math.min(cw - mx, ox));
    const clampedOy = Math.max(-wh + my, Math.min(ch - my, oy));
    this.panX += clampedOx - ox;
    this.panY += clampedOy - oy;
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
    fillIndexedBuffer(model, this.buf32!);
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

  /** Draw a translucent brush-size ring at a world position, on top of the sim. */
  drawCursor(worldX: number, worldY: number, radius: number, css: string): void {
    const ctx = this.ctx;
    const sx = this.ox + worldX * this.scale;
    const sy = this.oy + worldY * this.scale;
    const r = Math.max(this.scale * 0.5, (radius + 0.5) * this.scale);
    ctx.save();
    ctx.lineWidth = Math.max(1, this.scale * 0.12);
    ctx.strokeStyle = css;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render `model` to a standalone PNG data URL at native cell resolution
   * (integer-upscaled, nearest-neighbour) — independent of the live zoom/pan so
   * captures are always the full, crisp world.
   */
  exportPNG(model: RenderModel): string {
    return modelToPNG(model);
  }

  private drawParticles(model: ParticlesModel): void {
    this.layout(model.width, model.height);
    paintParticles(this.ctx, model, this.ox, this.oy, this.scale);
  }
}

/**
 * Draw a particle model as species-grouped filled squares into `ctx`, mapping
 * world coordinates through (ox, oy, scale). Shared by the live renderer
 * (ox/oy/scale = the current viewport transform) and the PNG export
 * (ox=oy=0, scale = the integer upscale). fillStyle is set once per species to
 * minimise canvas state changes; no allocation, so it is safe on the per-frame
 * path.
 */
function paintParticles(
  ctx: CanvasRenderingContext2D,
  model: ParticlesModel,
  ox: number,
  oy: number,
  scale: number,
): void {
  const { xs, ys, species, palette, count, radius, background } = model;

  ctx.fillStyle = rgbaToCss(background);
  ctx.fillRect(ox, oy, model.width * scale, model.height * scale);

  const r = Math.max(1, radius * scale);
  const d = r * 2;
  const ns = palette.length;
  for (let sp = 0; sp < ns; sp++) {
    ctx.fillStyle = rgbaToCss(palette[sp]!);
    for (let i = 0; i < count; i++) {
      if (species[i] !== sp) continue;
      ctx.fillRect(ox + xs[i]! * scale - r, oy + ys[i]! * scale - r, d, d);
    }
  }
}

/**
 * Fill a preallocated RGBA buffer from a cells/field model: cells map state →
 * palette (out-of-range states fall back to palette[0]); field clamps the value
 * to [0,1] and indexes the colormap LUT. Shared by the live renderer and the
 * PNG export so the index→colour mapping lives in exactly one place. Takes the
 * caller's buffer and allocates nothing, so it is safe on the per-frame path.
 */
function fillIndexedBuffer(model: CellsModel | FieldModel, buf: Uint32Array): void {
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
}

/**
 * Paint any render model into a fresh, detached canvas at an integer upscale and
 * return a PNG data URL. Shared by the export button and the gallery thumbnails;
 * it depends only on `document.createElement`, never on layout, so it works for
 * offscreen canvases too. `targetPx` is the desired longest edge.
 */
export function modelToPNG(model: RenderModel, targetPx = 1024): string {
  const k = Math.max(1, Math.min(16, Math.round(targetPx / Math.max(model.width, model.height))));
  const c = document.createElement('canvas');
  c.width = model.width * k;
  c.height = model.height * k;
  const cx = c.getContext('2d');
  if (!cx) return '';
  cx.imageSmoothingEnabled = false;

  if (model.kind === 'particles') {
    paintParticles(cx, model, 0, 0, k);
    return c.toDataURL('image/png');
  }

  const tmp = document.createElement('canvas');
  tmp.width = model.width;
  tmp.height = model.height;
  const tctx = tmp.getContext('2d');
  if (!tctx) return '';
  const img = tctx.createImageData(model.width, model.height);
  const buf = new Uint32Array(img.data.buffer);
  fillIndexedBuffer(model, buf);
  tctx.putImageData(img, 0, 0);
  cx.drawImage(tmp, 0, 0, model.width, model.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function clampn(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
