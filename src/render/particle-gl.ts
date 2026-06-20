import type { ParticlesModel } from '../core/types';

/**
 * WebGL2 additive-glow renderer for the `particles` model. It draws each particle
 * as an instanced soft sprite (a unit quad with a radial falloff in the fragment
 * shader) blended additively, so dense clusters bloom toward their colour the way
 * real luminous matter does.
 *
 * It is a *draw-only* layer: it never touches simulation state, so determinism is
 * unaffected. The simulation still runs on the CPU/worker and hands us the same
 * `ParticlesModel` the 2D path consumes. If WebGL2 is unavailable, `tryCreate`
 * returns null and the caller falls back to the canvas-2D square renderer.
 *
 * Buffer discipline matches the rest of vivarium: one persistent instance buffer,
 * grown only when the particle count exceeds its capacity — no per-frame GPU
 * allocation.
 */

const MAX_SPECIES = 8;

/** Sprite half-size as a multiple of the particle's world radius. */
const GLOW = 2.1;
/** Overall brightness of the additive contribution. */
const INTENSITY = 1.1;

const VERT = `#version 300 es
layout(location = 0) in vec2 aCorner;   // unit quad corner in [-1, 1]
layout(location = 1) in vec2 aPos;      // per-instance world position
layout(location = 2) in float aSpecies; // per-instance species index

uniform vec2 uResolution;   // device px
uniform float uScale;       // world units -> device px
uniform vec2 uOrigin;       // world origin in device px (top-left), y down
uniform float uHalfSize;    // sprite half-size in device px
uniform vec3 uPalette[${MAX_SPECIES}];

out vec2 vUv;
out vec3 vColor;

void main() {
  vec2 screen = uOrigin + aPos * uScale;     // device px, y down
  vec2 pos = screen + aCorner * uHalfSize;
  vec2 clip = (pos / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;                          // device y-down -> clip y-up
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = aCorner;
  int idx = int(aSpecies + 0.5);
  vColor = uPalette[idx];
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec3 vColor;

uniform float uIntensity;

out vec4 fragColor;

void main() {
  float d = length(vUv);                   // 0 at centre, ~1 at the quad edge
  if (d > 1.0) discard;
  float core = smoothstep(0.55, 0.0, d);   // crisp luminous body (~ the particle)
  float halo = exp(-d * d * 4.0) * 0.45;   // tight, soft surrounding glow
  float a = clamp(core + halo, 0.0, 1.0);
  // Premultiplied additive output (blend func ONE, ONE).
  fragColor = vec4(vColor * a * uIntensity, a);
}`;

interface Uniforms {
  resolution: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  origin: WebGLUniformLocation | null;
  halfSize: WebGLUniformLocation | null;
  intensity: WebGLUniformLocation | null;
  palette: WebGLUniformLocation | null;
}

export class ParticleGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly prog: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instBuf: WebGLBuffer;
  private readonly u: Uniforms;

  /** Interleaved [x, y, species] per particle, reused across frames. */
  private instData = new Float32Array(0);
  private cap = 0;
  private readonly palette = new Float32Array(MAX_SPECIES * 3);

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement) {
    this.gl = gl;
    this.canvas = canvas;

    this.prog = link(gl, VERT, FRAG);

    const vao = gl.createVertexArray();
    const cornerBuf = gl.createBuffer();
    const instBuf = gl.createBuffer();
    if (!vao || !cornerBuf || !instBuf) throw new Error('WebGL buffer allocation failed');
    this.vao = vao;
    this.instBuf = instBuf;

    gl.bindVertexArray(vao);

    // Static unit quad drawn as a triangle strip.
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Per-instance [x, y, species]; pointers are recorded into the VAO now and
    // stay valid as the buffer's storage is re-sized later.
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 12, 8);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);

    this.u = {
      resolution: gl.getUniformLocation(this.prog, 'uResolution'),
      scale: gl.getUniformLocation(this.prog, 'uScale'),
      origin: gl.getUniformLocation(this.prog, 'uOrigin'),
      halfSize: gl.getUniformLocation(this.prog, 'uHalfSize'),
      intensity: gl.getUniformLocation(this.prog, 'uIntensity'),
      palette: gl.getUniformLocation(this.prog, 'uPalette[0]'),
    };
  }

  /** Create a renderer, or null if WebGL2 / shader compilation is unavailable. */
  static tryCreate(canvas: HTMLCanvasElement): ParticleGL | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        depth: false,
        stencil: false,
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new ParticleGL(gl, canvas);
    } catch {
      return null;
    }
  }

  private ensureCap(count: number): void {
    if (count <= this.cap) return;
    const cap = Math.max(count, this.cap === 0 ? 1024 : this.cap * 2);
    this.instData = new Float32Array(cap * 3);
    this.cap = cap;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);
  }

  private syncSize(deviceW: number, deviceH: number): void {
    if (this.canvas.width !== deviceW) this.canvas.width = deviceW;
    if (this.canvas.height !== deviceH) this.canvas.height = deviceH;
  }

  /**
   * Draw the particle field. `scale`, `ox`, `oy` are the same world→device
   * viewport transform the 2D renderer computed, so the two layers register
   * pixel-for-pixel; `deviceW/H` are the 2D canvas backing-store dimensions.
   */
  draw(model: ParticlesModel, scale: number, ox: number, oy: number, deviceW: number, deviceH: number): void {
    const gl = this.gl;
    this.syncSize(deviceW, deviceH);
    gl.viewport(0, 0, deviceW, deviceH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { count, xs, ys, species, palette } = model;
    if (count === 0) return;

    this.ensureCap(count);
    const data = this.instData;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      data[o] = xs[i]!;
      data[o + 1] = ys[i]!;
      data[o + 2] = species[i]!;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 3);

    const pal = this.palette;
    const ns = Math.min(palette.length, MAX_SPECIES);
    for (let i = 0; i < ns; i++) {
      const v = palette[i]!;
      pal[i * 3] = (v & 0xff) / 255;
      pal[i * 3 + 1] = ((v >>> 8) & 0xff) / 255;
      pal[i * 3 + 2] = ((v >>> 16) & 0xff) / 255;
    }

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.resolution, deviceW, deviceH);
    gl.uniform1f(this.u.scale, scale);
    gl.uniform2f(this.u.origin, ox, oy);
    gl.uniform1f(this.u.halfSize, Math.max(1.5, model.radius * scale * GLOW));
    gl.uniform1f(this.u.intensity, INTENSITY);
    gl.uniform3fv(this.u.palette, pal);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);

    gl.bindVertexArray(null);
  }

  /** Clear the overlay (e.g. when switching to a non-particle system). */
  clear(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

function link(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('WebGL program allocation failed');
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  // Shaders can be detached/deleted once linked.
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL program link failed: ${log ?? 'unknown'}`);
  }
  return prog;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL shader compile failed: ${log ?? 'unknown'}`);
  }
  return sh;
}
