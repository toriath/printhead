# PRINTHEAD

A finite idle game about a 3D printer that eventually prints everything.
The binding specification is [`docs/printhead-spec-v0.4.md`](docs/printhead-spec-v0.4.md).

> **Status:** M0 — skeleton. Monorepo, content pipeline, pacing plumbing and CI
> are in place; the game loop itself lands in M1.

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

Other scripts: `pnpm mutation` (Stryker on `systems/` + `curves/`),
`pnpm balance:sim` (headless harness vs. the §6 phase budgets),
`pnpm e2e` (Playwright smoke; run `pnpm exec playwright install chromium` once), `pnpm --filter @printhead/app dev`.

## Layout

```
packages/core       pure TS simulation — content/, engine/, state/, systems/,
                    curves/, visual/, save/, rng/ (no DOM, no Math.random, no Date.now)
packages/renderer   React SVG, a pure function of VisualState
packages/app        shell, store bridge, PWA target
packages/editor     dev-only schema-driven content inspector
packages/platform   storage + clock facade (web / Tauri)
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
