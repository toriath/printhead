# ADR-001 — The simulation stays pure TypeScript

- **Status:** Accepted (spec v0.4, §10). Do not revisit without new requirements.
- **Date:** 2026-08-12
- **Deciders:** PRINTHEAD spec v0.4
- **Milestone:** recorded in M0

## Context

PRINTHEAD's simulation is a deterministic, fixed-timestep idle-game reducer:
100 ms ticks, a few hundred entities at most, ~8 h of total play. A
Rust → WebAssembly simulation core was evaluated as an alternative to the
TypeScript `packages/core` package, on the usual grounds (performance,
stronger type system, property/mutation tooling maturity).

## Decision

The simulation stays **pure TypeScript** in `packages/core`, with zero DOM,
React or platform dependencies.

## Rationale

- **No performance need.** At idle-game scale the tick loop is trivial work;
  offline catch-up (24 h capped, 100 ms steps ≈ 864 000 ticks) already runs in
  well under a second in plain JS. There is no budget to reclaim.
- **One toolchain.** Rust would add cargo, `cargo-mutants`, `proptest` and
  `schemars` *beside* the existing Vitest / fast-check / Stryker / zod stack —
  two mutation testers, two property frameworks, two schema systems, two CI
  caches, for one small reducer.
- **Serialization cost at the boundary.** `VisualState` crosses the sim →
  renderer boundary every frame, and content definitions cross the other way on
  every hot reload. In JS both are plain object references; across JS ↔ WASM
  they become copies plus a schema to keep in sync.
- **Iteration speed.** The agent workflow (spec §12) depends on fast
  edit → test → balance-run loops and on hot-reloading `content/*.json` into a
  live sim. A WASM rebuild step sits directly in that loop.
- **Determinism is already solved in TS.** Seeded mulberry32 streams plus the
  no-`Math.random` / no-`Date.now` rule (spec §13) give bit-identical replays
  without leaving the language.

## Consequences

- `packages/core` compiles with `lib: ["ES2022"]` and no `types` — DOM APIs are
  not merely discouraged, they are unavailable. `dependency-cruiser` forbids
  imports from `renderer`/`app`/`editor`/`platform` and from React.
- Determinism is enforced by convention plus tests rather than by the language:
  injected `rng` and `nowMs` in `ReduceContext`, and CI guards.
- Quality that Rust would have provided structurally is bought with tooling
  instead: strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  zod-validated content, fast-check invariants and a Stryker mutation gate
  (≥ 80 % on `systems/` + `curves/`).
- If a future requirement genuinely needs native compute (it is hard to imagine
  one for this game), this ADR gets superseded, not amended.

## Alternatives considered

1. **Rust → WASM core.** Rejected, see above.
2. **AssemblyScript.** Same boundary costs, smaller ecosystem, no real win.
3. **TypeScript with a WASM hot path later.** Kept theoretically open: the
   reducer is pure and content-driven, so a hot path could be swapped behind the
   same interface — but nothing today justifies it.
