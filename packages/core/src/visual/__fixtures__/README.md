# VisualState fixture corpus

`VisualState` is the contract between the simulation and every renderer
(spec §1, §15). These documents freeze it: each one is parsed with the *strict*
`VisualStateSchema` in `../schema.ts`, so adding a field breaks them (missing
key) and removing one breaks them too (unknown key). Either way the only way
forward is to bump `VISUAL_STATE_VERSION` and add fresh fixtures — which is
what "frozen" is supposed to cost.

They are exported from `core` as `VISUAL_STATE_FIXTURES` because spec §13 asks
that *every* `VisualState` fixture renders; the renderer's test consumes exactly
the documents the projection's freeze test does.

| Fixture | Source | What it pins |
|---|---|---|
| `fresh.json` | generated | initial save — empty bay, nothing attached |
| `assembling.json` | generated | mid-intro, three pieces on the bench |
| `assembled.json` | generated | printer #1 built, no config loaded |
| `printing.json` | generated | the bench loop, one slot mid-batch |
| `economy.json` | generated | M3: a machine node installed, an automation running, scrap in the bin |
| `showcase.json` | hand-authored | four bays, three machine tiers, badges, a purge in progress, one empty outline |

Regenerate the *generated* ones (only when adding a new version) with:

```bash
pnpm tsx scripts/make-visual-fixtures.ts
```

`showcase.json` is written by hand on purpose: the simulation still has one
slot, so nothing it can produce exercises the tier variants or the `×N` badges
the renderer has to draw. It is schema-valid and represents a state the game
reaches at M4; when the sim can produce it, it should become generated like the
rest.

Validation is **lazy and memoised** (`visualStateFixtures()`), not run at import
time. The corpus is still checked the moment anything reads it — which every
test that touches a fixture does — but the module stays importable by
`scripts/make-visual-fixtures.ts`, whose whole job is to rewrite the very
documents it would otherwise fail to load.
