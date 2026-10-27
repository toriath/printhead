# PRINTHEAD

A finite idle game about a 3D printer. **The complete, binding specification is
`docs/printhead-spec-v0.4.md` — read it fully before doing anything.**

## Ground rules (summary — the spec wins on any conflict)

- Work milestone by milestone (spec §18, M0 → M7). One milestone = one epic branch.
- Everything must build and test **inside this devcontainer**. Never assume host tools.
- All gameplay numbers live in `packages/core/content/` as data — no literals in `systems/` (CI-enforced).
- TDD by default; Stryker mutation score ≥ 80 % on core systems (nightly CI job); balance bots enforce the 8 h pacing budget in CI (arc ±20 %, each phase ±35 %).
- The simulation is pure TypeScript (ADR-001 — do not revisit) with no DOM deps, no `Math.random`, no `Date.now`.
- The renderer is a pure function of the versioned `VisualState`.
- If balancing feels manual, build/extend `tools/balance` first (spec §12).

## Current status

- [x] M0 — skeleton: monorepo, content pipeline, pacing plumbing, CI (merged `d86c038`)
- [x] M1 — core loop + balance harness v1 (merged via `epic/m1`)
- [x] M2 — renderer v1, VisualState v1, app shell, e2e (merged via `epic/m2`)
- [x] M3 — economy, market, failure/recycler, tooling v2, editor v1 (merged `e85e6fa`)
- [x] M4 — slots 2–4, fleet allocation, Farm/Goliath fork (merged `dcd9eb2`)
- [x] M5 — Design Studio, prestige → Plates, money printing, editor v2 (merged `f7529da`)
- [x] M6 — endgame tree, inflation, Fabricator final print, ending, NG+ (merged `d762599`)
- [ ] M7 not started: PWA polish, save-corpus hardening, printable STL (§20), web/itch release, Tauri macOS (iOS/mobile dropped: desktop first).
