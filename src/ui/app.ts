import { el, clear } from './dom';
import { CanvasRenderer } from '../render/renderer';
import { systems, getSystem } from '../core/registry';
import type { ParamSpec, ParamValue, Params, Simulation, SystemDef } from '../core/types';
import { defaultParams } from '../core/types';

const MAX_STEPS_PER_FRAME = 240;

interface Control {
  set(v: ParamValue): void;
}

export function mountApp(root: HTMLElement): void {
  new App(root);
}

class App {
  private renderer: CanvasRenderer;
  private canvas: HTMLCanvasElement;
  private galleryEl: HTMLElement;
  private panelEl: HTMLElement;
  private genEl: HTMLElement;
  private hashEl: HTMLElement;
  private fpsEl: HTMLElement;
  private playBtn: HTMLButtonElement;

  private sys: SystemDef;
  private params: Params;
  private seed = 1;
  private presetId: string | undefined;
  private sim: Simulation;

  private playing = true;
  private sps = 15;
  private brushValue = 1;
  private brushRadius = 1;

  private controls = new Map<string, Control>();
  private painting = false;

  private acc = 0;
  private lastTime = 0;
  private frames = 0;
  private fpsClock = 0;
  private hashClock = 0;

  constructor(root: HTMLElement) {
    this.sys = systems[0]!;
    this.params = defaultParams(this.sys.params);
    this.presetId = this.sys.presets?.[0]?.id;

    const canvas = el('canvas', { class: 'viv-canvas' });
    this.canvas = canvas;
    this.galleryEl = el('div', { class: 'viv-gallery-list' });
    this.panelEl = el('div', { class: 'viv-panel-body' });
    this.genEl = el('span', { class: 'viv-stat-val', text: '0' });
    this.hashEl = el('span', { class: 'viv-stat-val', text: '—' });
    this.fpsEl = el('span', { class: 'viv-stat-val', text: '0' });
    this.playBtn = el('button', { class: 'viv-btn viv-btn-primary', text: 'Pause' });

    root.append(this.buildLayout());
    this.renderer = new CanvasRenderer(canvas);
    this.sim = this.sys.create(this.params, this.seed, this.presetId);

    this.buildGallery();
    this.buildPanel();
    this.attachCanvasEvents();
    this.attachKeyboard();

    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  private buildLayout(): HTMLElement {
    const header = el(
      'header',
      { class: 'viv-header' },
      el('div', { class: 'viv-brand' },
        el('span', { class: 'viv-logo', text: '◉' }),
        el('h1', { class: 'viv-title', text: 'vivarium' }),
        el('span', { class: 'viv-subtitle', text: 'artificial life sandbox' }),
      ),
      el('div', { class: 'viv-stats' },
        el('span', { class: 'viv-stat' }, el('label', { text: 'gen' }), this.genEl),
        el('span', { class: 'viv-stat' }, el('label', { text: 'hash' }), this.hashEl),
        el('span', { class: 'viv-stat' }, el('label', { text: 'fps' }), this.fpsEl),
      ),
    );

    const gallery = el('aside', { class: 'viv-gallery' },
      el('div', { class: 'viv-section-label', text: 'systems' }),
      this.galleryEl,
    );

    const stage = el('main', { class: 'viv-stage' },
      this.canvas,
      el('div', { class: 'viv-hint', text: 'click + drag on the canvas to paint' }),
    );

    const panel = el('aside', { class: 'viv-panel' }, this.panelEl);

    return el('div', { class: 'viv-root' }, header, gallery, stage, panel);
  }

  private buildGallery(): void {
    clear(this.galleryEl);
    for (const s of systems) {
      const active = s.id === this.sys.id;
      const btn = el(
        'button',
        {
          class: 'viv-gallery-item' + (active ? ' is-active' : ''),
          dataset: { systemId: s.id },
          on: { click: () => this.selectSystem(s.id) },
        },
        el('span', { class: 'viv-gallery-name', text: s.name }),
        el('span', { class: 'viv-gallery-tag', text: s.tagline }),
      );
      this.galleryEl.append(btn);
    }
  }

  private selectSystem(id: string): void {
    const next = getSystem(id);
    if (!next || next.id === this.sys.id) return;
    this.sys = next;
    this.params = defaultParams(next.params);
    this.presetId = next.presets?.[0]?.id;
    this.brushValue = (next.brushStates ?? 2) > 1 ? 1 : 0;
    this.brushRadius = 1;
    this.recreate();
    this.buildGallery();
    this.buildPanel();
  }

  // ── Control panel ────────────────────────────────────────────────────────────

  private buildPanel(): void {
    clear(this.panelEl);
    this.controls.clear();

    this.panelEl.append(
      el('div', { class: 'viv-panel-head' },
        el('h2', { class: 'viv-panel-title', text: this.sys.name }),
        el('p', { class: 'viv-panel-desc', text: this.sys.description }),
      ),
    );

    // Transport
    this.playBtn = el('button', {
      class: 'viv-btn viv-btn-primary',
      text: this.playing ? 'Pause' : 'Play',
      on: { click: () => this.togglePlay() },
    });
    const transport = el('div', { class: 'viv-transport' },
      this.playBtn,
      el('button', { class: 'viv-btn', text: 'Step', on: { click: () => this.stepOnce() } }),
      el('button', { class: 'viv-btn', text: 'Reset', on: { click: () => this.reset() } }),
      el('button', { class: 'viv-btn', text: 'Clear', on: { click: () => this.clearSim() } }),
    );
    this.panelEl.append(this.section('controls', transport));

    // Speed
    const speedReadout = el('span', { class: 'viv-readout', text: `${this.sps}/s` });
    const speed = el('input', {
      type: 'range', min: 1, max: 200, step: 1, value: this.sps,
      on: {
        input: (e) => {
          this.sps = Number((e.target as HTMLInputElement).value);
          speedReadout.textContent = `${this.sps}/s`;
        },
      },
    });
    this.panelEl.append(this.field('Speed', speed, speedReadout));

    // Seed
    const seedInput = el('input', {
      type: 'number', value: this.seed, class: 'viv-number',
      on: {
        change: (e) => {
          this.seed = Math.trunc(Number((e.target as HTMLInputElement).value)) || 0;
          this.recreate();
        },
      },
    });
    const dice = el('button', {
      class: 'viv-btn viv-btn-icon', text: '⟳', title: 'Randomize seed',
      on: { click: () => this.randomize() },
    });
    this.panelEl.append(this.field('Seed', el('div', { class: 'viv-row' }, seedInput, dice)));
    this.seedInput = seedInput;

    // Presets
    if (this.sys.presets && this.sys.presets.length > 0) {
      const select = el('select', {
        class: 'viv-select',
        on: { change: (e) => this.applyPreset((e.target as HTMLSelectElement).value) },
      });
      for (const p of this.sys.presets) {
        const opt = el('option', { value: p.id, text: p.label });
        if (p.id === this.presetId) opt.selected = true;
        select.append(opt);
      }
      this.presetSelect = select;
      this.panelEl.append(this.field('Preset', select));
    } else {
      this.presetSelect = undefined;
    }

    // Parameters
    if (this.sys.params.length > 0) {
      const paramBox = el('div', { class: 'viv-params' });
      for (const spec of this.sys.params) paramBox.append(this.buildParamControl(spec));
      this.panelEl.append(this.section('parameters', paramBox));
    }

    // Brush
    this.panelEl.append(this.buildBrush());
  }

  private section(label: string, body: HTMLElement): HTMLElement {
    return el('div', { class: 'viv-section' },
      el('div', { class: 'viv-section-label', text: label }), body);
  }

  private field(label: string, ...controls: HTMLElement[]): HTMLElement {
    return el('label', { class: 'viv-field' },
      el('span', { class: 'viv-field-label', text: label }),
      el('div', { class: 'viv-field-control' }, ...controls));
  }

  private buildParamControl(spec: ParamSpec): HTMLElement {
    const key = spec.key;
    switch (spec.kind) {
      case 'int':
      case 'float': {
        const isInt = spec.kind === 'int';
        const step = spec.step ?? (isInt ? 1 : 0.01);
        const cur = Number(this.params[key]);
        const readout = el('span', { class: 'viv-readout', text: fmtNum(cur, isInt) });
        const input = el('input', {
          type: 'range', min: spec.min, max: spec.max, step, value: cur,
          on: {
            input: (e) => {
              const v = Number((e.target as HTMLInputElement).value);
              this.params[key] = v;
              readout.textContent = fmtNum(v, isInt);
              this.recreate();
            },
          },
        });
        this.controls.set(key, {
          set: (v) => {
            input.value = String(v);
            readout.textContent = fmtNum(Number(v), isInt);
          },
        });
        return this.field(spec.label, input, readout);
      }
      case 'bool': {
        const input = el('input', {
          type: 'checkbox', checked: Boolean(this.params[key]),
          on: {
            change: (e) => {
              this.params[key] = (e.target as HTMLInputElement).checked;
              this.recreate();
            },
          },
        });
        this.controls.set(key, {
          set: (v) => { (input as HTMLInputElement).checked = Boolean(v); },
        });
        return this.field(spec.label, el('div', { class: 'viv-row' }, input,
          el('span', { class: 'viv-check-hint', text: spec.help ?? '' })));
      }
      case 'select': {
        const select = el('select', {
          class: 'viv-select',
          on: {
            change: (e) => {
              this.params[key] = (e.target as HTMLSelectElement).value;
              this.recreate();
            },
          },
        });
        for (const o of spec.options) {
          const opt = el('option', { value: o.value, text: o.label });
          if (o.value === this.params[key]) opt.selected = true;
          select.append(opt);
        }
        this.controls.set(key, {
          set: (v) => { (select as HTMLSelectElement).value = String(v); },
        });
        return this.field(spec.label, select);
      }
      case 'rule': {
        const input = el('input', {
          type: 'text', class: 'viv-text', value: String(this.params[key]),
          placeholder: spec.placeholder ?? '',
          on: {
            change: (e) => {
              this.params[key] = (e.target as HTMLInputElement).value;
              this.recreate();
            },
          },
        });
        this.controls.set(key, {
          set: (v) => { (input as HTMLInputElement).value = String(v); },
        });
        return this.field(spec.label, input);
      }
    }
  }

  private buildBrush(): HTMLElement {
    const states = this.sys.brushStates ?? 2;
    const swatches = el('div', { class: 'viv-swatches' });
    const colors = this.sys.brushColors;
    for (let v = 0; v < states; v++) {
      const color = colors?.[v] ?? (v === 0 ? '#0a0e14' : '#5ef2c4');
      const sw = el('button', {
        class: 'viv-swatch' + (v === this.brushValue ? ' is-active' : ''),
        style: `--swatch:${color}`,
        title: v === 0 ? 'Erase' : `Brush ${v}`,
        dataset: { v: String(v) },
        on: {
          click: () => {
            this.brushValue = v;
            for (const node of swatches.children)
              node.classList.toggle('is-active', node.getAttribute('data-v') === String(v));
          },
        },
      }, el('span', { class: 'viv-swatch-dot' }));
      swatches.append(sw);
    }
    const radiusReadout = el('span', { class: 'viv-readout', text: String(this.brushRadius) });
    const radius = el('input', {
      type: 'range', min: 0, max: 12, step: 1, value: this.brushRadius,
      on: {
        input: (e) => {
          this.brushRadius = Number((e.target as HTMLInputElement).value);
          radiusReadout.textContent = String(this.brushRadius);
        },
      },
    });
    const box = el('div', {},
      swatches,
      this.field('Brush size', radius, radiusReadout),
    );
    return this.section('brush', box);
  }

  private seedInput: HTMLInputElement | undefined;
  private presetSelect: HTMLSelectElement | undefined;

  private refreshPresetSelect(): void {
    if (this.presetSelect && this.presetId) this.presetSelect.value = this.presetId;
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private recreate(): void {
    this.sim = this.sys.create(this.params, this.seed, this.presetId);
    this.updateStatus();
  }

  private applyPreset(id: string): void {
    this.presetId = id;
    const preset = this.sys.presets?.find((p) => p.id === id);
    if (preset?.params) {
      for (const [k, v] of Object.entries(preset.params)) {
        if (v === undefined) continue;
        this.params[k] = v;
        this.controls.get(k)?.set(v);
      }
    }
    this.recreate();
  }

  private togglePlay(): void {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
  }

  private stepOnce(): void {
    this.sim.step();
    this.updateStatus();
  }

  private reset(): void {
    this.recreate();
  }

  private clearSim(): void {
    if (this.sim.clear) {
      this.sim.clear();
      this.updateStatus();
    } else {
      this.presetId = 'empty';
      this.recreate();
      this.refreshPresetSelect();
    }
  }

  private randomize(): void {
    this.seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    if (this.seedInput) this.seedInput.value = String(this.seed);
    if (this.sys.presets?.some((p) => p.id === 'random')) this.presetId = 'random';
    this.recreate();
    this.refreshPresetSelect();
  }

  // ── Canvas interaction ───────────────────────────────────────────────────────

  private attachCanvasEvents(): void {
    const paintAt = (e: PointerEvent): void => {
      if (!this.sim.paint) return;
      const { x, y } = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.sim.paint({ x, y, value: this.brushValue, radius: this.brushRadius });
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.painting = true;
      this.canvas.setPointerCapture(e.pointerId);
      paintAt(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.painting) paintAt(e);
    });
    const stop = (e: PointerEvent): void => {
      this.painting = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
  }

  private attachKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      switch (e.key) {
        case ' ': e.preventDefault(); this.togglePlay(); break;
        case 's': this.stepOnce(); break;
        case 'r': this.reset(); break;
        case 'n': this.randomize(); break;
        case 'c': this.clearSim(); break;
      }
    });
  }

  // ── Run loop ─────────────────────────────────────────────────────────────────

  private loop(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.playing) {
      this.acc += dt * this.sps;
      let steps = Math.floor(this.acc);
      if (steps > 0) {
        this.acc -= steps;
        if (steps > MAX_STEPS_PER_FRAME) steps = MAX_STEPS_PER_FRAME;
        for (let i = 0; i < steps; i++) this.sim.step();
      }
    }

    this.renderer.draw(this.sim.render());

    this.frames++;
    if (now - this.fpsClock >= 500) {
      const fps = (this.frames * 1000) / (now - this.fpsClock);
      this.fpsEl.textContent = String(Math.round(fps));
      this.frames = 0;
      this.fpsClock = now;
    }
    if (now - this.hashClock >= 400) {
      this.updateStatus();
      this.hashClock = now;
    } else {
      this.genEl.textContent = String(this.sim.generation);
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  private updateStatus(): void {
    this.genEl.textContent = String(this.sim.generation);
    this.hashEl.textContent = this.sim.hash();
  }
}

function fmtNum(v: number, isInt: boolean): string {
  return isInt ? String(Math.round(v)) : v.toFixed(2);
}
