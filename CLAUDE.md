# vivarium

Client-side artificial-life sandbox: a gallery of deterministic cellular-automata
and life systems. TypeScript (strict) + Vite, pnpm, static, no backend, no GPU.
Light runtime, heavy build.

## Commands

- `pnpm dev` — dev server
- `pnpm typecheck` — `tsc --noEmit` (strict)
- `pnpm test` — Vitest (known-outcome + determinism tests)
- `pnpm build` — static bundle into `dist/`
- `pnpm screens` — build + Playwright screenshots into `screens/`

After changing a system, run `pnpm typecheck && pnpm test && pnpm build` and keep all three green.

## Deploy

Public repo (MIT), fully static (`base: './'` — serves from any host/subpath).
Production: **Cloudflare Pages** → https://vivarium.nuez.no (builds `pnpm build` →
`dist/` on push to `main`). CF runs neither typecheck nor tests, so
`.github/workflows/ci.yml` is kept as a CI gate (typecheck + test + build).

## Architecture

Everything implements two interfaces in `src/core/types.ts`:

- **`SystemDef`** — metadata, a declarative parameter schema, presets, and `create(params, seed, preset)`.
- **`Simulation`** — `step()`, `render()` (a `cells` / `field` / `particles` model), `hash()`, optional `paint()` / `clear()`.

Layout:

- `src/core/` — `types.ts` (the contract), `prng.ts` (mulberry32), `hash.ts` (FNV-1a), `registry.ts`
- `src/systems/` — one self-contained module per system (+ shared `lifelike-core.ts`)
- `src/render/` — canvas-2D renderer (typed arrays → `ImageData`, nearest-neighbour blit)
- `src/ui/` — framework-free gallery + auto-generated controls + painting

## Rules

- **Determinism is mandatory**: all randomness comes from a seeded `mulberry32`, never `Math.random`. `hash()` must fold all mutable state, so the same seed + N steps always yields the same hash.
- `render()` reuses persistent buffers — no per-frame allocation.
- Every system needs a known-outcome test plus determinism coverage; registry-level snapshots live in `test/determinism.test.ts`.

## Add a system

Create `src/systems/<id>.ts` exporting `const <id>System: SystemDef`, add a test in `test/`, then register it in `src/core/registry.ts`.
