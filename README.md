# PRINTHEAD

A finite idle game about a 3D printer that eventually prints everything.
The binding specification is [`docs/printhead-spec-v0.4.md`](docs/printhead-spec-v0.4.md).

> **Status:** M2 — renderer v1. The game is playable in a browser for phase
> 0–1: assemble printer #1 piece by piece (each click adds a part to the SVG
> machine that keeps printing afterwards), load the slot, print, sell, buy
> filament, buy printers. It installs as a PWA, autosaves to IndexedDB and
> shows a "welcome back" summary of what the workshop did while you were away.
> `VisualState` is frozen at v3 behind a strict schema and a fixture corpus.
> Economy, materials, market and the editor panel land in M3.

## Quick start (inside the devcontainer)

```bash
pnpm install
pnpm check          # the single verification entrypoint
```

`pnpm check` runs, in order:

| Step | Command | Enforces |
|---|---|---|
| Lint + format | `biome ci .` | spec §10 |
| Content | `tsx scripts/check-content.ts` | zod schemas, unique ids, no dangling refs (§11) |
| No literals | `tsx scripts/check-no-literals.ts` | no gameplay numbers in `core/src/systems` (§11) |
| Pace | `tsx scripts/check-pace-scale.ts` | `paceScale` applied in exactly one place (§8) |
| Imports | `depcruise …` | `core` imports nothing from renderer/app/editor/platform (§19) |
| Types | `tsc -b` | strict, `noUncheckedIndexedAccess`, project refs (§10) |
| Tests | `vitest run` | every package (§13) |
| Coverage | `vitest run --coverage` (core) | ≥ 90 % line/branch on the simulation (§13, §17) |

Other scripts: `pnpm mutation` (Stryker on `systems/` + `curves/`),
`pnpm balance:sim [botId]` (headless harness vs. the §6 phase budgets),
`pnpm e2e` (Playwright; run `pnpm exec playwright install chromium` once),
`pnpm --filter @printhead/app dev` (dev server with live content reload).

## Playing it

```bash
pnpm --filter @printhead/app dev      # http://localhost:5173
```

Editing any file in `packages/core/content/` swaps the definitions into the
running simulation without a reload (spec §11) — change `pacing.targetHours`
and watch the game speed up mid-print.

### Rendering (spec §4, §5A, §15)

The renderer is a **pure function of `VisualState`**: same projection in, same
markup out, no state, no clock, no content lookups. The projection is frozen at
v3 by a strict zod schema plus the fixture corpus in
`packages/core/src/visual/__fixtures__/`, which the renderer's own tests render.

- one animated machine **per slot**, never per printer, with an `×N` badge;
- empty and locked bays as faint outlines, up to `start.maxSlotCount` (§4);
- machine tiers change the SVG — frame acrylic/aluminium/steel, nozzle
  brass/hardened/glowing, bed tape/heated/auto-level (§5A), snapshot-tested;
- the idle print-head sweep is CSS keyframes desynchronised by the projection's
  `phaseOffset`, so the renderer never needs a clock of its own.

### E2E and the dev test seam

At `targetHours: 8` the intro takes five real minutes, which no browser test
can wait for. Dev builds therefore expose `window.__PRINTHEAD__` (spec §14):
it freezes the platform clock and lets a test step the frame loop. Nothing else
is faked — the reducer, the pace mapping and the phase gates are the shipped
ones, and a warped intro still needs the same seven clicks. The seam lives
behind `import.meta.env.DEV`, and `smoke.prod.spec.ts` asserts it is absent
from the production bundle.

## Balancing

Numbers are never guessed. `tools/balance` runs the real `core` headlessly with
a bot, and the phase budgets in `content/pacing.json` are asserted in CI:

```bash
pnpm balance:sim                 # reference bot (greedy-spender) vs. §6 budgets
pnpm balance:sim idle            # lower bound: never leaves the intro
```

To move a number, fit it rather than pick it. `tunePhase` bisects a single
content field until a phase lands on its budget, addressing content by id so a
reordered file cannot silently retarget the knob:

```ts
tunePhase(
  { pointer: 'curves/printer-cost-tier1/base', phaseId: 'bench', lo: 10, hi: 400 },
  { raw: RAW_CONTENT },
);
```

The result ships as a **data diff** in `packages/core/content/`, never as a
constant in code. Sweep, wait-wall detection and the report generator are M3.

> **Read the green light correctly.** Only `intro` and `bench` are gated on real
> mechanics so far (assemble + print + sell, then own 4 printers). Phases
> `farm`…`end` advance on `phaseDesignMinutes` alone, so they sit on budget by
> construction and will stay green no matter what the economy does. They become
> meaningful gates as M3–M6 add the mechanics behind them. The last phase also
> absorbs any drift from the earlier ones, because the run stops at the total
> budget rather than at a gate of its own.

## Layout

```
packages/core       pure TS simulation — content/, engine/, state/, systems/,
                    curves/, visual/, save/, rng/ (no DOM, no Math.random, no Date.now)
packages/renderer   React SVG, a pure function of VisualState
packages/app        shell, HUD, store bridge, engine loop, autosave, PWA
packages/editor     dev-only schema-driven content inspector
packages/platform   storage (IndexedDB) + clock + lifecycle facade (web / Tauri)
tools/balance       headless harness, bots, budget assertions
tools/stl           printable PRINTHEAD generator (M7)
e2e                 Playwright suites
docs/adr            architecture decisions (ADR-001: the sim stays TypeScript)
```

## Rules that CI will not let you break

1. **All gameplay numbers live in `packages/core/content/*.json`** — validated by
   zod, cross-referenced by id, never hard-coded in `systems/`.
2. **One master pace variable.** `pacing.targetHours` maps wall-clock to sim time
   in `core/src/engine/pace.ts` and nowhere else; `targetHours: 4` halves the game.
3. **One reducer.** Every state change is an `Action` through
   `reduce(state, action, ctx)`; `TICK` is an action; `dt = 100 ms`.
4. **`core` is portable.** No DOM, no React, no wall clock, no `Math.random`.
5. **New persistent field ⇒ save version bump + migration + fixture, same commit.**
6. **New mechanic ⇒ bot support in `tools/balance` + a property invariant, same commit.**
7. **`VisualState` is frozen.** Changing its shape means bumping
   `VISUAL_STATE_VERSION` and adding fixtures; the old ones will not validate.
