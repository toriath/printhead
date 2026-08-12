# PRINTHEAD

A finite idle game about a 3D printer. **The complete, binding specification is
`docs/printhead-spec-v0.4.md` — read it fully before doing anything.**

## Ground rules (summary — the spec wins on any conflict)

- Work milestone by milestone (spec §18, M0 → M7). One milestone = one epic branch.
- Everything must build and test **inside this devcontainer**. Never assume host tools.
- All gameplay numbers live in `packages/core/content/` as data — no literals in `systems/` (CI-enforced).
- TDD by default; Stryker mutation score ≥ 80 % on core systems; balance bots enforce the 8 h pacing budget in CI.
- The simulation is pure TypeScript (ADR-001 — do not revisit) with no DOM deps, no `Math.random`, no `Date.now`.
- The renderer is a pure function of the versioned `VisualState`.
- If balancing feels manual, build/extend `tools/balance` first (spec §12).

## Current status

- [ ] M0 not started. Begin with: devcontainer CI parity, pnpm monorepo, content pipeline, pacing plumbing.
