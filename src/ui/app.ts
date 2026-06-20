import { el, clear } from './dom';
import { CanvasRenderer } from '../render/renderer';
import { systems, getSystem } from '../core/registry';
import type { ParamSpec, ParamValue, Params, SystemDef } from '../core/types';
import { paramsForPreset } from '../core/types';
import { encodeUrlState, decodeUrlState, SPS_MIN, SPS_MAX, type UrlState } from './url-state';
import { makeThumbnail } from './thumbnails';
import { COLORMAPS, DEFAULT_COLORMAP_ID, colormapLut, isColormapId } from '../render/colormaps';
import { SimClient } from '../sim/sim-client';

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
  private helpOverlay!: HTMLElement;
  private helpCloseBtn!: HTMLButtonElement;
  private safetyOverlay!: HTMLElement;
  private safetyContinueBtn!: HTMLButtonElement;
  private lastFocus: HTMLElement | null = null;

  private sys: SystemDef;
  private params: Params;
  private seed = 1;
  private presetId: string | undefined;
  private client: SimClient;

  private playing = true;
  private sps = 15;
  private brushValue = 1;
  private brushRadius = 1;
  private colormapId = DEFAULT_COLORMAP_ID;

  private controls = new Map<string, Control>();
  private thumbs = new Map<string, string>();
  private painting = false;
  private panning = false;
  private lastPanX = 0;
  private lastPanY = 0;
  private hoverX = 0;
  private hoverY = 0;
  private hovering = false;
  private urlTimer = 0;

  private recreateRaf = 0;
  // Stepping lives in the worker now; the main loop only paces `run` ticks.
  private pendingRun = false;
  private lastRunSent = 0;
  private frames = 0;
  private fpsClock = 0;
  private hashClock = 0;

  constructor(root: HTMLElement) {
    this.sys = systems[0]!;
    this.presetId = this.sys.presets?.[0]?.id;
    this.params = paramsForPreset(this.sys, this.presetId);

    // Restore a shared deterministic permalink, if one is present in the URL.
    const restored = decodeUrlState(location.hash, getSystem);
    if (restored) this.adoptState(restored);

    // Hold autoplay until the photosensitive notice is acknowledged, so no
    // motion runs behind the warning on a first visit.
    const needsSafety = !hasAckedSafety();
    if (needsSafety) this.playing = false;

    const canvas = el('canvas', { class: 'viv-canvas' });
    this.canvas = canvas;
    this.galleryEl = el('div', { class: 'viv-gallery-list' });
    this.panelEl = el('div', { class: 'viv-panel-body' });
    this.genEl = el('span', { class: 'viv-stat-val', text: '0' });
    this.hashEl = el('span', { class: 'viv-stat-val', text: '—' });
    this.fpsEl = el('span', { class: 'viv-stat-val', text: '0' });
    this.playBtn = el('button', { class: 'viv-btn viv-btn-primary', text: 'Pause' });

    root.append(this.buildLayout());
    this.helpOverlay = this.buildHelpOverlay();
    root.append(this.helpOverlay);
    this.safetyOverlay = this.buildSafetyNotice();
    root.append(this.safetyOverlay);
    this.renderer = new CanvasRenderer(canvas);
    this.client = new SimClient(colormapLut(this.colormapId));
    // Release the run guard only when a *run* tick returns — a paint/step/clear
    // frame interleaved ahead of an in-flight run must not let a second run out.
    this.client.onFrame = (fromRun) => { if (fromRun) this.pendingRun = false; };
    this.client.create(this.sys.id, this.params, this.seed, this.presetId);

    this.buildGallery();
    this.buildPanel();
    this.attachCanvasEvents();
    this.attachKeyboard();
    this.attachHashSync();
    this.syncUrl(true); // canonicalise the URL on first load

    this.maybeShowSafetyNotice();
    this.lastRunSent = performance.now();
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
      el('div', { class: 'viv-hint', text: 'drag to paint · scroll to zoom · alt-drag to pan · ? for shortcuts' }),
    );

    const panel = el('aside', { class: 'viv-panel' }, this.panelEl);

    return el('div', { class: 'viv-root' }, header, gallery, stage, panel);
  }

  /** A modal cheat-sheet of every keyboard and mouse shortcut, toggled with "?". */
  private buildHelpOverlay(): HTMLElement {
    const rows: Array<[string, string]> = [
      ['Space', 'Play / pause'],
      ['S', 'Step one generation'],
      ['R', 'Reset (re-seed)'],
      ['N', 'New random seed'],
      ['C', 'Clear the grid'],
      ['F', 'Fit view'],
      ['E', 'Export PNG'],
      ['+ / −', 'Zoom in / out'],
      ['?', 'Toggle this help'],
      ['Drag', 'Paint cells'],
      ['Scroll', 'Zoom to cursor'],
      ['Alt-drag', 'Pan the view'],
      ['Double-click', 'Reset the view'],
    ];
    const list = el('div', { class: 'viv-help-list' });
    for (const [k, d] of rows) {
      list.append(el('div', { class: 'viv-help-row' },
        el('kbd', { class: 'viv-kbd', text: k }),
        el('span', { class: 'viv-help-desc', text: d })));
    }
    const title = el('h2', { class: 'viv-help-title', id: 'viv-help-title', text: 'Shortcuts' });
    this.helpCloseBtn = el('button', {
      class: 'viv-btn viv-btn-icon', text: '✕', title: 'Close',
      on: { click: () => this.toggleHelp(false) },
    });
    const card = el('div', { class: 'viv-help-card' },
      el('div', { class: 'viv-help-head' }, title, this.helpCloseBtn),
      list);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'viv-help-title');
    const overlay = el('div', {
      class: 'viv-help-overlay',
      on: {
        click: (e) => { if (e.target === overlay) this.toggleHelp(false); },
        // Trap Tab inside the card (only the close button is focusable).
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Tab') {
            e.preventDefault();
            this.helpCloseBtn.focus();
          }
        },
      },
    }, card);
    return overlay;
  }

  private toggleHelp(force?: boolean): void {
    const open = force ?? !this.helpOverlay.classList.contains('is-open');
    if (open === this.helpOverlay.classList.contains('is-open')) return;
    this.helpOverlay.classList.toggle('is-open', open);
    if (open) {
      this.lastFocus = document.activeElement as HTMLElement | null;
      this.helpCloseBtn.focus();
    } else {
      this.lastFocus?.focus?.();
      this.lastFocus = null;
    }
  }

  /**
   * A one-time photosensitive-seizure warning. Several systems (Cyclic CA,
   * Brian's Brain, scrolling Rule 30, Particle Life) can strobe at high speed,
   * so a first visit is greeted with a modal that gates autoplay until it is
   * acknowledged; the acknowledgement is remembered in localStorage.
   */
  private buildSafetyNotice(): HTMLElement {
    const title = el('h2', { class: 'viv-safety-title', id: 'viv-safety-title', text: 'Photosensitive warning' });
    const body = el('p', {
      class: 'viv-safety-body',
      text:
        'Some systems here produce rapidly flashing, strobing or high-contrast moving ' +
        'patterns. If you have photosensitive epilepsy or are sensitive to flashing light, ' +
        'take care — lower the speed, keep the window small, or sit back from the screen. ' +
        'You can pause at any time with the Space bar.',
    });
    this.safetyContinueBtn = el('button', {
      class: 'viv-btn viv-btn-primary',
      text: 'I understand — continue',
      on: { click: () => this.ackSafety() },
    });
    const card = el('div', { class: 'viv-help-card viv-safety-card' },
      el('div', { class: 'viv-safety-head' },
        el('span', { class: 'viv-safety-icon', text: '⚠' }),
        title),
      body,
      el('div', { class: 'viv-safety-actions' }, this.safetyContinueBtn));
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'viv-safety-title');
    // No backdrop-click or Escape dismissal: acknowledging is required. Trap Tab
    // on the single focusable control.
    const overlay = el('div', {
      class: 'viv-help-overlay viv-safety-overlay',
      on: {
        keydown: (e) => {
          if ((e as KeyboardEvent).key === 'Tab') {
            e.preventDefault();
            this.safetyContinueBtn.focus();
          }
        },
      },
    }, card);
    return overlay;
  }

  private maybeShowSafetyNotice(): void {
    if (hasAckedSafety()) return;
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.safetyOverlay.classList.add('is-open');
    this.safetyContinueBtn.focus();
  }

  private ackSafety(): void {
    try { localStorage.setItem(SAFETY_KEY, '1'); } catch { /* private mode — show again next time */ }
    this.safetyOverlay.classList.remove('is-open');
    this.lastFocus?.focus?.();
    this.lastFocus = null;
    // Resume the autoplay that was held back while the notice was up.
    if (!this.playing) {
      this.playing = true;
      this.playBtn.textContent = 'Pause';
      this.lastRunSent = performance.now();
    }
  }

  private buildGallery(): void {
    clear(this.galleryEl);
    for (const s of systems) {
      const active = s.id === this.sys.id;
      const thumb = el('img', { class: 'viv-gallery-thumb', dataset: { thumb: s.id } });
      thumb.alt = '';
      thumb.decoding = 'async';
      const cached = this.thumbs.get(s.id);
      if (cached) thumb.src = cached;
      const btn = el(
        'button',
        {
          class: 'viv-gallery-item' + (active ? ' is-active' : ''),
          dataset: { systemId: s.id },
          on: { click: () => this.selectSystem(s.id) },
        },
        thumb,
        el('div', { class: 'viv-gallery-text' },
          el('span', { class: 'viv-gallery-name', text: s.name }),
          el('span', { class: 'viv-gallery-tag', text: s.tagline }),
        ),
      );
      this.galleryEl.append(btn);
    }
    this.scheduleThumbnails();
  }

  /** Compute any missing gallery thumbnails one per tick, off the first paint. */
  private scheduleThumbnails(): void {
    const pending = systems.filter((s) => !this.thumbs.has(s.id));
    let i = 0;
    const tick = (): void => {
      if (i >= pending.length) return;
      const s = pending[i++]!;
      const url = makeThumbnail(s);
      if (url) {
        this.thumbs.set(s.id, url);
        const img = this.galleryEl.querySelector<HTMLImageElement>(`img[data-thumb="${s.id}"]`);
        if (img) img.src = url;
      }
      window.setTimeout(tick, 0);
    };
    window.setTimeout(tick, 0);
  }

  private selectSystem(id: string): void {
    const next = getSystem(id);
    if (!next || next.id === this.sys.id) return;
    this.sys = next;
    this.presetId = next.presets?.[0]?.id;
    this.params = paramsForPreset(next, this.presetId);
    this.brushValue = (next.brushStates ?? 2) > 1 ? 1 : 0;
    this.brushRadius = 1;
    this.renderer.resetView();
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

    // Speed (logarithmic — see spsToPos / posToSps)
    const speedReadout = el('span', { class: 'viv-readout', text: `${this.sps}/s` });
    const speed = el('input', {
      type: 'range', min: 0, max: SPS_TICKS, step: 1, value: spsToPos(this.sps),
      on: {
        input: (e) => {
          this.sps = posToSps(Number((e.target as HTMLInputElement).value));
          speedReadout.textContent = `${this.sps}/s`;
          this.syncUrl();
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

    // Colormap — cosmetic, field systems only; applied live with no rebuild.
    if (this.sys.renderKind === 'field') {
      const select = el('select', {
        class: 'viv-select',
        on: {
          change: (e) => {
            this.colormapId = (e.target as HTMLSelectElement).value;
            this.client.setColormap(colormapLut(this.colormapId));
            this.syncUrl();
          },
        },
      });
      for (const c of COLORMAPS) {
        const opt = el('option', { value: c.id, text: c.label });
        if (c.id === this.colormapId) opt.selected = true;
        select.append(opt);
      }
      this.panelEl.append(this.section('render', this.field('Colormap', select)));
    }

    // Brush
    this.panelEl.append(this.buildBrush());

    // Share — a deterministic permalink reproduces this exact run anywhere.
    const copyBtn = el('button', { class: 'viv-btn', text: 'Copy link' });
    copyBtn.addEventListener('click', () => void this.copyLink(copyBtn));
    const pngBtn = el('button', {
      class: 'viv-btn', text: 'Export PNG',
      on: { click: () => this.exportPng() },
    });
    const share = el('div', { class: 'viv-share' },
      el('div', { class: 'viv-share-row' }, copyBtn, pngBtn),
      el('p', { class: 'viv-share-note', text: 'link reproduces this exact run — same seed, params & speed' }),
    );
    this.panelEl.append(this.section('share', share));
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

  /** Append the authored `help` text below a control, when present. */
  private withHelp(control: HTMLElement, help?: string): HTMLElement {
    if (!help) return control;
    return el('div', { class: 'viv-field-wrap' },
      control,
      el('p', { class: 'viv-field-help', text: help }));
  }

  private buildParamControl(spec: ParamSpec): HTMLElement {
    const key = spec.key;
    switch (spec.kind) {
      case 'int':
      case 'float': {
        const isInt = spec.kind === 'int';
        const step = spec.step ?? (isInt ? 1 : 0.01);
        const dec = isInt ? 0 : decimalsForStep(step);
        const cur = Number(this.params[key]);
        const readout = el('span', { class: 'viv-readout', text: fmtNum(cur, isInt, dec) });
        const input = el('input', {
          type: 'range', min: spec.min, max: spec.max, step, value: cur,
          on: {
            input: (e) => {
              const v = Number((e.target as HTMLInputElement).value);
              this.params[key] = v;
              readout.textContent = fmtNum(v, isInt, dec);
              this.scheduleRecreate();
            },
          },
        });
        this.controls.set(key, {
          set: (v) => {
            input.value = String(v);
            readout.textContent = fmtNum(Number(v), isInt, dec);
          },
        });
        return this.withHelp(this.field(spec.label, input, readout), spec.help);
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
        return this.withHelp(this.field(spec.label, select), spec.help);
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
        return this.withHelp(this.field(spec.label, input), spec.help);
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
    this.cancelPendingRecreate();
    // The new epoch invalidates any run frame still in flight (it will be dropped
    // as stale and never release the guard), so clear it here to avoid a stall.
    this.pendingRun = false;
    this.client.setColormap(colormapLut(this.colormapId));
    this.client.create(this.sys.id, this.params, this.seed, this.presetId);
    this.syncUrl();
  }

  /**
   * Coalesce a rebuild to the next animation frame. Dragging a parameter slider
   * fires `input` many times per frame; rebuilding (a full grid realloc + reseed)
   * on each one is the dominant cost for the heavy field systems. The readout and
   * `this.params` update synchronously for instant feedback, while the actual
   * rebuild runs at most once per frame.
   */
  private scheduleRecreate(): void {
    if (this.recreateRaf) return;
    this.recreateRaf = requestAnimationFrame(() => {
      this.recreateRaf = 0;
      this.recreate();
    });
  }

  /**
   * Drop a queued rebuild. Direct mutations of the live sim — a Clear, or a
   * brush stroke — must call this first, otherwise a rebuild scheduled by a
   * just-dragged slider would fire on the next frame and silently wipe the
   * user's edit (rebuilding a fresh seeded grid from params).
   */
  private cancelPendingRecreate(): void {
    if (this.recreateRaf) {
      cancelAnimationFrame(this.recreateRaf);
      this.recreateRaf = 0;
    }
  }

  // ── Shareable permalinks ───────────────────────────────────────────────────

  /** Apply a decoded URL state onto the live config (no rebuild side effects). */
  private adoptState(s: UrlState): void {
    const sys = getSystem(s.sys);
    if (!sys) return;
    this.sys = sys;
    this.params = { ...paramsForPreset(sys, s.preset), ...s.params };
    this.seed = s.seed;
    this.sps = s.sps;
    this.presetId = s.preset ?? sys.presets?.[0]?.id;
    this.brushValue = (sys.brushStates ?? 2) > 1 ? 1 : 0;
    this.brushRadius = 1;
    this.colormapId = s.cm && isColormapId(s.cm) ? s.cm : DEFAULT_COLORMAP_ID;
  }

  /** Mirror the current configuration into the URL hash (debounced). */
  private syncUrl(immediate = false): void {
    const write = (): void => {
      const hash = encodeUrlState(this.snapshot());
      history.replaceState(null, '', '#' + hash);
    };
    if (this.urlTimer) clearTimeout(this.urlTimer);
    if (immediate) write();
    else this.urlTimer = window.setTimeout(write, 150);
  }

  /** React to externally-changed hashes (pasted links, back/forward). */
  private attachHashSync(): void {
    window.addEventListener('hashchange', () => {
      const s = decodeUrlState(location.hash, getSystem);
      if (!s) return;
      const sameConfig =
        s.sys === this.sys.id &&
        s.seed === this.seed &&
        s.preset === this.presetId &&
        encodeUrlState(s) === encodeUrlState(this.snapshot());
      if (sameConfig) return; // our own replaceState, nothing to do
      this.adoptState(s);
      this.renderer.resetView();
      this.recreate();
      this.buildGallery();
      this.buildPanel();
    });
  }

  private snapshot(): UrlState {
    return {
      sys: this.sys.id,
      seed: this.seed,
      sps: this.sps,
      preset: this.presetId,
      params: this.params,
      cm: this.colormapId,
    };
  }

  private async copyLink(btn: HTMLButtonElement): Promise<void> {
    this.syncUrl(true);
    const url = location.href;
    const label = btn.textContent ?? 'Copy link';
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Copied ✓';
    } catch {
      btn.textContent = 'Press ⌘C';
    }
    window.setTimeout(() => { btn.textContent = label; }, 1400);
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
    this.client.step();
  }

  private reset(): void {
    this.recreate();
  }

  private clearSim(): void {
    this.cancelPendingRecreate();
    // Favour the in-worker clear() path during cold-start: before the first frame
    // lands `mirror` is null, but the worker processes `create` before `clear`
    // (FIFO), so a clear() command resolves correctly. The `recreate('empty')`
    // fallback is only for a sim with no clear() — never the case mid-cold-start.
    if (!this.client.mirror || this.client.mirror.caps.clear) {
      this.client.clear();
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
    const c = this.canvas;
    const paintAt = (e: PointerEvent): void => {
      if (!this.client.mirror?.caps.paint) return;
      this.cancelPendingRecreate(); // a brush stroke must survive a just-dragged slider's queued rebuild
      const { x, y } = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.client.paint({ x, y, value: this.brushValue, radius: this.brushRadius });
    };

    // Wheel = zoom toward the cursor.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    // Alt-drag or middle-button drag = pan; plain drag = paint.
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.altKey) {
        this.panning = true;
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        e.preventDefault();
      } else {
        this.painting = true;
        paintAt(e);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const w = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.hoverX = w.x;
      this.hoverY = w.y;
      this.hovering = true;
      if (this.panning) {
        this.renderer.panBy(e.clientX - this.lastPanX, e.clientY - this.lastPanY);
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
      } else if (this.painting) {
        paintAt(e);
      }
    });
    const stop = (e: PointerEvent): void => {
      this.painting = false;
      this.panning = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('pointerleave', () => { this.hovering = false; });
    c.addEventListener('dblclick', () => this.renderer.resetView());
  }

  private brushCss(): string {
    return this.sys.brushColors?.[this.brushValue] ?? (this.brushValue === 0 ? '#8893a5' : '#5ef2c4');
  }

  private zoomCenter(factor: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.renderer.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  private exportPng(): void {
    const m = this.client.mirror;
    if (!m) return;
    const url = this.renderer.exportPNG(m.model);
    if (!url) return;
    const a = el('a', {}) as HTMLAnchorElement;
    a.href = url;
    a.download = `vivarium_${this.sys.id}_seed${this.seed}_gen${m.generation}_${m.hash}.png`;
    a.click();
  }

  private attachKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      // The safety notice must be acknowledged with the button; swallow every
      // shortcut (including Space, which would otherwise start playback) until then.
      if (this.safetyOverlay.classList.contains('is-open')) return;
      // While the help modal is up, only let it be dismissed — don't let the
      // shortcuts it documents mutate the sim hidden behind the backdrop.
      if (this.helpOverlay.classList.contains('is-open') && e.key !== 'Escape' && e.key !== '?') {
        return;
      }
      switch (e.key) {
        case ' ': e.preventDefault(); this.togglePlay(); break;
        case 's': this.stepOnce(); break;
        case 'r': this.reset(); break;
        case 'n': this.randomize(); break;
        case 'c': this.clearSim(); break;
        case 'f': this.renderer.resetView(); break;
        case 'e': this.exportPng(); break;
        case '+': case '=': this.zoomCenter(1.2); break;
        case '-': case '_': this.zoomCenter(1 / 1.2); break;
        case '?': e.preventDefault(); this.toggleHelp(); break;
        case 'Escape': this.toggleHelp(false); break;
      }
    });
  }

  // ── Run loop ─────────────────────────────────────────────────────────────────

  private loop(now: number): void {
    // Pace the worker: keep at most one `run` tick in flight, carrying the
    // wall-time since the last one was sent so no sim time is lost while it
    // computes. rAF gates this, so a backgrounded tab stops stepping entirely.
    if (this.playing) {
      if (!this.pendingRun) {
        const dt = Math.min(0.1, (now - this.lastRunSent) / 1000);
        this.client.run(dt, this.sps);
        this.pendingRun = true;
        this.lastRunSent = now;
      }
    } else {
      this.lastRunSent = now; // keep fresh so unpausing doesn't trigger a catch-up jump
    }

    const mirror = this.client.mirror;
    if (mirror) {
      this.renderer.draw(mirror.model);
      if (this.hovering && mirror.caps.paint) {
        this.renderer.drawCursor(this.hoverX, this.hoverY, this.brushRadius, this.brushCss());
      }
    }

    this.frames++;
    if (now - this.fpsClock >= 500) {
      const fps = (this.frames * 1000) / (now - this.fpsClock);
      this.fpsEl.textContent = String(Math.round(fps));
      this.frames = 0;
      this.fpsClock = now;
    }
    // hash/gen arrive precomputed in the frame, so this is a cheap string write;
    // the hash is still throttled to avoid per-frame DOM churn.
    if (mirror) {
      if (now - this.hashClock >= 400) {
        this.updateStatus();
        this.hashClock = now;
      } else {
        this.genEl.textContent = String(mirror.generation);
      }
    }

    requestAnimationFrame((t) => this.loop(t));
  }

  private updateStatus(): void {
    const m = this.client.mirror;
    this.genEl.textContent = String(m ? m.generation : 0);
    this.hashEl.textContent = m ? m.hash : '—';
  }
}

function fmtNum(v: number, isInt: boolean, decimals = 2): string {
  return isInt ? String(Math.round(v)) : v.toFixed(decimals);
}

// Photosensitive notice acknowledgement, persisted across visits.
const SAFETY_KEY = 'viv:safety-ack';

function hasAckedSafety(): boolean {
  try { return localStorage.getItem(SAFETY_KEY) === '1'; } catch { return false; }
}

// Speed slider runs on a logarithmic scale so the low end (1–20/s, where the
// dynamics are actually watchable) gets the bulk of the travel instead of being
// crammed into the first few pixels of a linear track. `sps` itself stays linear
// everywhere else (URL, run loop); only the slider position is warped. SPS_MIN /
// SPS_MAX are shared with the URL codec so the control and the permalink agree
// on the ceiling.
const SPS_TICKS = 1000;

function spsToPos(sps: number): number {
  const s = sps < SPS_MIN ? SPS_MIN : sps > SPS_MAX ? SPS_MAX : sps;
  return Math.round((SPS_TICKS * Math.log(s / SPS_MIN)) / Math.log(SPS_MAX / SPS_MIN));
}

function posToSps(pos: number): number {
  const s = SPS_MIN * Math.pow(SPS_MAX / SPS_MIN, pos / SPS_TICKS);
  return Math.max(SPS_MIN, Math.min(SPS_MAX, Math.round(s)));
}

/** Decimal places implied by a slider step (0.001 → 3), so readouts aren't lossy. */
function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(4, s.length - dot - 1);
}
