# PRINTHEAD — Spec v0.4
*A finite idle game about a 3D printer that eventually prints everything.*
*This document is the complete context for implementation: game design, architecture, stack, testing, balancing, tooling, editor, CI, release. Read fully before writing code. v0.4 supersedes all earlier versions.*

**Changed in v0.4:** the simulation **stays TypeScript** — a Rust/WASM sim was evaluated and rejected (§10, ADR-001); new deliverable: **agent-generated printable STL** of the in-game printer (§20, shipped in M7).
**Changed in v0.3:** ~8 h total playtime via a **single pace variable**; balance/content values are **data, not code**; the agent **builds its own balancing tooling**; **dev game editor** for manual tweaks.

---

# PART I — GAME DESIGN

## 1. Core Principles

- **One resource rules the early game:** the generic **Part** — simultaneously currency and upgrade component.
- **Config slots** limit simultaneous print configurations (§4). Early game: exactly 1. Never unlimited.
- **Decoupled rendering:** the simulation emits a versioned `VisualState`; the renderer is a pure function of it. Rendering is decorative and never reads sim internals.
- **The game ends.** Target: **~8 h total** (±20 %), tunable via one variable (§8). Every system exists to be automated, trivialized, and retired.

## 2. Resources

| Resource | Source | Sinks | Notes |
|---|---|---|---|
| **Filament** (per material) | Purchase; recycled scrap; late-game printed | Consumed by printing | PLA infinite to buy; others market-priced, stock-limited |
| **Parts** | Printing | Sell for Money; invest in printers/upgrades | Core token; quality tier = material printed in |
| **Scrap** | Failed prints | Recycler → filament | Failure consolation loop |
| **Money** | Selling parts/products; prestige printing | Filament, trades, some upgrades | Soft currency |
| **Designs** | Design Studio | Enable Products; **persist through prestige** | Permanent meta-progression |
| **Products** | Printing a Design | Sell (high margin) | Design level multiplies value |
| **Plates** | Prestige reward | Money-printing rate; Endgame Tree | Prestige currency (engraved printing plates) |

### Resource Flow

```
   Money ──buy──►  FILAMENT  ◄──recycle── Scrap
                      │ print (via slots)    ▲
                      ▼                      │ failure %
                    PARTS ───────────────────┘
              sell ◄──┴──► invest (printers · upgrades · maintenance)
                ▼
             MONEY ──► market/auto-trading
                └──► Design Studio ──► DESIGNS ──print──► PRODUCTS ──► MONEY++
                                          │ (persist)
                                          ▼
                 PRESTIGE: melt down ──► PLATES ──► print MONEY directly
                                          ▼
                          ENDGAME TREE ──► Universal Fabricator ──► END
```

## 3. Material Identities

All objects printable in all materials; each material has one mechanical identity:

| Material | Identity | Failure | Cost | Gate |
|---|---|---|---|---|
| PLA | Cheap & infinite | High | ~Free | Start |
| PETG | Balanced workhorse | Medium | Market | Phase 2 |
| Resin (SLA) | Fine detail — **required** for Designs/Products/Plates | Low, slow | High | Phase 3 |
| Metal | **Required** for late printers/upgrades | Very low | Very high | Phase 4 |
| Composite/exotic | Endgame only | — | Plates | Phase 5 |

Changing a slot's configuration has a **changeover cost** (time + filament waste).

## 4. Config Slots

- A **slot** = one active print configuration `{ material, objectType }`. Printers are **assigned to slots**; all printers in a slot print its config.
- Slot progression **1 → 2 → 3 → 4 (hard max)**; slot 3 expensive, slot 4 prestige-gated. "Just enough," never trivial.
- The core decision evolves from "what am I printing?" to "how do I allocate my fleet across slots?"
- The final Fabricator print requires **all slots** — a deliberate return to total commitment.

### Rendering rule
**Render once per slot**, not per printer: one animated printer visual per occupied slot, reflecting the slot's material/object and the best machine tier among its printers, plus a count badge (`×7`). Empty slots: faint outline. Max 4 slot visuals; the Goliath path replaces them with one large printer.

## 5. Upgrade Trees

**A. Machine** (every node changes the SVG): frame acrylic→aluminum→steel; nozzle brass→hardened→glowing; bed tape→heated→auto-level; enclosure; second extruder (multi-material within one slot); SLA unit; speed/quality slider (fast+risky ↔ slow+reliable).

**B. Farm**: printer N cost ≈ base × growth^N (parts; growth is data); printer-to-slot assignment; print queues (auto-changeover per slot); **per-run fork:** *Farm* (throughput) vs. *Goliath* (one giant printer; required for the largest endgame builds).

**C. Automation** (introduce friction, then sell its removal): auto-sell threshold; auto-buy filament; auto-trading; maintenance bots (printed — printers degrade with runtime); auto-changeover; late auto-designer.

**D. Design**: Design Studio (needs resin); designs level per printed batch; design slots; designs persist through prestige; capstone **Money Plate design** → unlocks prestige.

**E. Endgame** (Plates only): money printer tiers (bills → bundles → pallets → "the central bank"); exotic materials; print a building (backdrop change); print a factory (outputs printers); **blueprint: Universal Fabricator**.

## 6. Game Arc & Time Budget (at `pace.targetHours = 8`)

| Phase | Content | Design budget |
|---|---|---|
| **0 — Intro** | Assemble printer #1 manually (6–8 clicks, each attaches an SVG piece); first Part | 5 min |
| **1 — Bench** | Manual loop, failure/scrap/recycler, printer #2 → PETG + heated bed | 30 min |
| **2 — Farm** | 3–8 printers, market opens, changeover pain → automation relieves it → SLA | 80 min |
| **3 — Studio** | Resin, designs, products; slots 2–3; Farm/Goliath fork → Money Plate designed | 75 min |
| **4 — Prestige runs 1–2** | Melt-down → Plates; intro replays **self-assembling**; money printing begins | 90 min |
| **5 — The Absurd (runs 3–4)** | Buildings, printer-printing factory; on-screen inflation — the economy eats itself | 80 min |
| **6 — The End** | Endgame tree + **Fabricator final print** (~30–40 min, the one synced render, layer by layer) → numbers fade to ∞ → museum shot of printer #1 → credits print out. Post-game: sandbox + NG+ | 60 min |
| | **Total** | **~420 min ≈ 7 h active + idle drift → 8 h ± 20 %** |

These budgets are **data** (`content/pacing.json`) and are enforced by automated balance bots in CI (§12, §13).

## 7. Resolved Design Defaults (overridable via data)

1. Failure: **deterministic pity-timer** (accumulated failure charge), not raw RNG.
2. Market: **sine + seeded noise + supply response** (flooding lowers price).
3. Goliath **required for the final print**; a Farm build can pre-print sections to stay viable.
4. Offline progress: **deterministic chunked fast-forward, capped 24 h**, summary screen on return.

---

# PART II — TECHNICAL SPEC

## 8. Pacing: One Master Variable

- `content/pacing.json` contains **`targetHours`** (default `8`). This is *the* knob.
- All content durations, rates, and curve constants are authored in **design units** calibrated to an 8-hour baseline. The engine computes `paceScale = targetHours / 8` once and applies it **in exactly one place** — the engine's mapping from wall-clock time to simulation progress (`simDt = dt / paceScale`). Nothing else may reference it.
- Consequences: `targetHours: 4` halves the game everywhere consistently (prints, cooldowns, market drift, degradation, final print). Costs/curves shape the *feel*; `targetHours` shapes the *length*. Offline catch-up uses the same code path, so it scales too.
- Dev time-warp (§14) multiplies **on top** of pace and exists only in dev builds.

## 9. Constraints (non-negotiable)

- Development in a **Linux devcontainer** on a MacBook; web build and the **entire test/tooling suite run in the container**. No host dependencies except Apple packaging.
- **Platforms: Web (primary, PWA from day one), macOS, iOS** via Tauri v2; signing/packaging manually on the macOS host is acceptable (scripted).
- Idiomatic strict TypeScript, explicit design patterns, high coverage **including mutation testing**, fully deterministic simulation.

## 10. Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | One language everywhere; agent-friendly |
| Monorepo | pnpm workspaces | Simple, container-friendly |
| App/renderer | React 18 + Vite | SVG-in-JSX ideal for the vector printer |
| Simulation | Pure TS `core` package, zero DOM/React deps | Testable, portable, renderer-swappable |
| Content/balance | **JSON data + zod schemas** (§11) | Values are data, not code |
| State | Pure-reducer store; React subscribes via selector hook | Sim is the store |
| Tests | Vitest + fast-check + **Stryker** + Playwright | See §13 |
| Lint/format | Biome (+ dependency-cruiser for import rules) | Deterministic for agents |
| Shell | **Tauri v2** | macOS + iOS from the same web bundle |
| CI | GitHub Actions **inside the devcontainer image** | Dev = CI, bit-for-bit |

**Why not Godot/Unity:** the renderer is deliberately HTML/CSS/SVG (later maybe RIVE, also web-embeddable). We borrow the *data patterns* of those engines (§11) without the engines.

**Decision — no Rust sim (ADR-001):** a Rust→WASM simulation was considered and rejected: zero performance need at idle-game scale, while it would cost a dual-language toolchain (cargo-mutants/proptest/schemars beside the TS stack), JS↔WASM serialization at the `VisualState` boundary, and slower iteration loops. The sim stays pure TypeScript. Record as `docs/adr/001-typescript-sim.md`; do not revisit without new requirements.

## 11. Content & Balance as Data (engine-style)

Follow the pattern of Unity ScriptableObjects / Godot Resources / Unreal DataAssets — **definitions are assets, systems are generic interpreters**:

- `packages/core/content/` holds JSON: `materials.json`, `upgrades.json`, `printers.json`, `designs.json`, `objects.json`, `market.json`, `automation.json`, `prestige.json`, `pacing.json`, `curves.json`.
- Every def: stable string `id`, display fields, and numeric fields **only here**. Cross-references by id. Curves as named parametric records (`{ type: "exponential", base, growth }`) interpreted by a small curve library.
- **zod schemas** validate all content at build and at load; schema + JSON + generated TS types stay in one folder. A broken ref or out-of-range value fails CI, not runtime.
- **Hard rule: no gameplay-numeric literals in `systems/`.** Systems read defs; a CI grep/lint step (custom Biome rule or script) fails on numeric literals in `core/src/systems/` (whitelist: 0, 1, array indices via named consts).
- Content is **hot-reloadable in dev** (Vite watch → sim swaps defs live) — this powers both the editor (§14) and fast agent iteration.
- Balance changes are therefore always **data diffs**, reviewable and golden-master-testable.

## 12. Balancing Tooling — Built by the Agent, for the Agent

The coding agent must **build its own balancing instruments before tuning numbers by hand**. Tooling lives in `tools/balance/` (a workspace package, tested like any code):

1. **Headless harness** (`pnpm balance:sim`): runs the real `core` at maximum speed with pluggable **bot strategies** (at minimum: `greedy-spender`, `balanced`, `idle-heavy` check-in-every-10-min). Outputs a run log: phase completion times, resource curves, decision counts.
2. **Wait-wall detector:** flags any stretch > N design-minutes where the bot had no affordable meaningful action — the classic idle-game dead zone. Budgeted per phase in `pacing.json`.
3. **Sweep runner** (`pnpm balance:sweep`): grid/random search over selected data fields (by JSON pointer), parallel across workers, emitting CSV.
4. **Auto-tuner** (`pnpm balance:tune`): simple optimizer (hill-climb / bisection per parameter) that adjusts chosen fields until phase times hit the §6 budget within tolerance; writes the winning values **back into `content/` via a proper patch**, never into code.
5. **Report generator** (`pnpm balance:report`): markdown + SVG charts (resource curves, phase timeline, wait-walls) into `docs/balance-reports/<date>/`; every balance PR must attach one.
6. **CI regression:** the `balanced` bot must finish each phase within budget ± 20 % and total within ± 20 %; wait-walls under budget. A balance regression fails CI exactly like a failing unit test.

Workflow mandate: when a milestone introduces a mechanic, the agent (a) extends the bots to use it, (b) runs sweep/tune to fit the time budget, (c) commits data + report. Manual number-guessing is a smell; the tools are the way.

## 13. Testing Strategy

| Layer | Tooling | Bar |
|---|---|---|
| `core` unit | Vitest | ≥ 90 % line/branch |
| `core` properties | fast-check | Resources ≥ 0; offline(2t) ≡ offline(t)∘offline(t); prestige preserves Designs exactly; money printing monotone in Plates; buy/sell round-trips never create value; **pace invariance:** phase order & unlock sequence identical for any `targetHours` |
| `core` mutation | **Stryker** | Score ≥ 80 % on `systems/` + curve library; CI-gated |
| Balance | `tools/balance` bots | §12 budgets as CI assertions |
| Content | zod + ref-checker | All content valid; no dangling ids; no literals in systems |
| `renderer` | Vitest + Testing Library | Every `VisualState` fixture renders; upgrade visuals snapshot-tested |
| E2E | Playwright (chromium, in container) | Intro; save→reload equality; offline summary; prestige; editor smoke (dev build) |
| Saves | Fixture corpus | Every released schema version loads forever |

TDD is the default working mode. Determinism rule: **no `Math.random`, no `Date.now` in `core`** — inject seeded `rng` (mulberry32, forkable streams) and `now`. Every bug reproducible from `(seed, actionLog)`.

## 14. Dev Game Editor (manual override, schema-driven)

A dev-only in-app **Editor panel** — think Unity Inspector for this game:

- **Content inspector:** browse & edit every content def live; forms are **generated from the zod schemas** (new content types appear in the editor automatically, zero editor code). Edits hot-apply to the running sim.
- **Write-back:** in dev, a small Vite middleware endpoint writes edited defs back to `content/*.json` (formatted, schema-validated) — manual tweaks land in the same files the auto-tuner writes.
- **Time controls:** pause, ×1/×10/×100 warp (on top of pace), jump-to-phase via prepared snapshot saves.
- **State tools:** GameState tree view, action log tail, seed set/reset, grant-resource cheats, save import/export.
- **Balance view:** live resource-curve sparklines and current phase timer vs. budget — the human twin of the bot reports.
- Excluded from production bundles via build flag (`import.meta.env.DEV` + separate chunk); Playwright smoke-tests it in dev builds.

## 15. Architecture & Patterns (name them in code)

- **Reducer/Command:** every change is an `Action` through one pure `reduce(state, action, ctx)`; `TICK` is an action. Enables replay/undo-in-dev/save-as-log.
- **Fixed-timestep engine:** accumulator, `dt = 100 ms`, pace applied once (§8); render reads at rAF pace; offline = chunked ticks, same code path, 24 h cap.
- **Strategy:** material identities, failure model, market model as pluggable strategies selected by content data.
- **State machine:** phases (Intro → … → Ended) as explicit FSM gating features/UI.
- **Observer/event bus:** sim emits domain events (`PRINT_COMPLETED`, `UPGRADE_INSTALLED`) for achievements/sound/flourishes; renderer state itself comes only from `VisualState`.
- **Projection (Adapter):** `toVisualState(gameState)` — versioned schema; one entry **per slot** `{ slotId, material, objectType, machineTier, printerCount, phaseOffset }`; later the RIVE input map.
- **Memento + migrations:** versioned JSON saves; every schema change ships a migration + fixture test.
- **Facade:** `platform` package hides storage (IndexedDB / Tauri fs), clock, lifecycle.
- **Data-interpreter:** systems are generic interpreters of content defs (§11) — the engine-style backbone.

## 16. Repository Layout

```
printhead/
├── .devcontainer/                 # node:22-bookworm + pnpm + Playwright deps + Biome
├── .github/workflows/             # ci.yml · release-web.yml
├── packages/
│   ├── core/
│   │   ├── content/               # ALL numbers live here (JSON + zod + generated types)
│   │   └── src/
│   │       ├── engine/            # tick, accumulator, pace, offline
│   │       ├── state/             # GameState, reducer, actions
│   │       ├── systems/           # printing, market, failure, automation, prestige (no literals!)
│   │       ├── curves/            # parametric curve interpreters
│   │       ├── visual/            # toVisualState (versioned)
│   │       ├── save/              # schema versions, migrations
│   │       └── rng/               # seeded PRNG, forkable
│   ├── renderer/                  # React SVG: Printer, Slot, Workshop, Goliath, FinalPrint
│   ├── app/                       # shell, HUD, PWA, store bridge
│   ├── editor/                    # dev-only schema-driven editor panel (§14)
│   └── platform/                  # storage/time facade: web + Tauri impls
├── tools/balance/                 # harness, bots, sweep, tune, report (§12)
├── tools/stl/                     # printable-model generator: code-CAD → STL (§20)
├── apps-tauri/                    # Tauri v2 (macOS/iOS)
├── e2e/                           # Playwright
└── docs/                          # this spec, ADRs, balance-reports/
```

## 17. Devcontainer, CI, Release

- **CI (`ci.yml`)**, inside the devcontainer image: `biome ci` → content validation → `tsc -b` → `vitest --coverage` → `stryker run` (gated) → **balance bots vs. budgets** → `playwright test` → `vite build`. Green CI = releasable, reproducible web build.
- **Web release:** tag → build → deploy (GitHub Pages/Cloudflare Pages) + **itch.io via butler** (existing account/workflow). PWA installable from day one.
- **macOS:** container builds web bundle → host runs `pnpm tauri build` (Xcode CLT), sign + notarize — `scripts/release-macos.sh`.
- **iOS:** host `pnpm tauri ios build` → Xcode → TestFlight → App Store; safe-area & touch-target audit; recompute offline progress on foreground (critical on iOS); `navigator.storage.persist()` on web.
- Versioning: Changesets; save-schema bump whenever state shape changes.

## 18. Implementation Milestones

- **M0 — Skeleton:** devcontainer, monorepo, CI green, Biome + dependency-cruiser rules, content pipeline (zod, validation, hot-reload), pacing plumbing (`targetHours` → `paceScale`).
- **M1 — Core loop + harness v1:** tick engine, Parts/Filament/Money, single slot, print+sell, seeded RNG, saves v1, **headless harness with first bot** proving the loop end-to-end.
- **M2 — Renderer v1:** slot-based printer SVG, machine-tier visuals, idle animation with phase offsets, `VisualState` v1 frozen.
- **M3 — Economy + tooling v2 + editor v1:** materials/strategies, pity failure + scrap + recycler, market + auto-trading, automation tier 1, changeover; **sweep/tune/report tools operational; balance budgets enforced in CI; editor panel with content inspector + time controls.**
- **M4 — Slots & scale:** slots 2–4, fleet assignment UI, Farm/Goliath fork, per-slot rendering with badges.
- **M5 — Meta + editor v2:** Design Studio, products, prestige melt-down → Plates, self-assembling intro replay, money printing; editor covers all content types via schema (should be automatic — verify).
- **M6 — Endgame:** Endgame tree, inflation display, Fabricator final print (the one synced render), ending sequence, credits, NG+/sandbox.
- **M7 — Ship:** PWA polish, offline UX, save-corpus hardening, editor stripped from prod bundle, **printable STL generated + CI-validated (§20)**, web + itch.io release; then Tauri macOS/iOS on host.

Each milestone: plan → tests → implement → mutation run → **balance run + report** → ADR update if architecture shifted.

## 19. Working Agreements for the Coding Agent

- `core` never imports `renderer`/`app`/`editor`/`platform` — CI-enforced (dependency-cruiser).
- Numbers live in `content/` only; the no-literals check on `systems/` is CI-enforced.
- Any new state field ⇒ save-schema bump + migration + fixture test, same PR.
- Any new mechanic ⇒ bot support + at least one property invariant + balance run, same PR.
- Balance changes ship as **data diffs with an attached generated report** — never hand-edited constants in code.
- **Build tools before tuning:** if balancing feels manual, extend `tools/balance` first.
- Conventional commits; one milestone = one epic branch; main stays green.

## 20. Physical Artifact: the Printable PRINTHEAD (STL)

The game about a 3D printer ships with a real, printable model of its own printer — a free thank-you download alongside releases.

- **Source of truth is code-CAD:** OpenSCAD or Python **build123d/CadQuery** in `tools/stl/` (both run headless in the devcontainer). The model is parametric and derives its silhouette from the renderer's SVG shapes — the flat vector printer, extruded into the physical world. Machine-tier variants (acrylic/aluminum/steel frame) are parameters matching §5A; default export is the max-tier printer.
- **Printability by construction:** watertight/manifold; minimum wall thickness ≥ 1.2 mm; no unsupported overhangs > 45° (or split into parts with printed pins); fits a 180 mm bed; target < 2 h print at 0.2 mm layer height.
- **CI-validated like everything else:** `pnpm stl:build` regenerates deterministically; `pnpm stl:check` runs a mesh audit (manifold, min thickness) plus a **PrusaSlicer CLI slice pass**. An unprintable model fails CI exactly like a failing test.
- **Release artifact:** `printhead.stl` (+ 3MF with recommended print settings) attached to every web/itch release, and linked from the post-credits screen: *"print your printer."*
- Milestone: **M7** deliverable; the generator is a normal workspace package with tests (geometry invariants: symmetry, bounding box, part count).
