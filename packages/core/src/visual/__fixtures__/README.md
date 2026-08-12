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
| `rack.json` | generated | M4: two bays, the fleet split between them, a print rota on the second |
| `goliath.json` | generated | M4: the other side of the fork — one giant printer, no rack |
| `showcase.json` | hand-authored | four bays, three machine tiers, badges, a purge in progress, one empty outline |

Regenerate the *generated* ones (only when adding a new version) with:

```bash
pnpm tsx scripts/make-visual-fixtures.ts
```

`showcase.json` is still written by hand, but for a narrower reason than it was
at M3. Multiple bays, count badges and mid-purge states are all reachable now
(`rack.json` and `goliath.json` are generated from real play), so the only thing
left that the simulation *cannot* produce is a rack with **different machine
tiers side by side**: `machineTier` is a property of the workshop — the machine
tree upgrades every bay at once — so every bay in a real save reports the same
tier, while the renderer still has to draw all three. When tiers become
per-slot, this fixture can be generated like the rest.

The M4 fixtures are produced by handing the wheel to the reference bot until
the phase where the fork unlocks, then making the slot, rota and fork decisions
through the real reducer — the farm gate is a grind rather than a few clicks,
and a fixture that skipped it would be a hand-written guess again.

Validation is **lazy and memoised** (`visualStateFixtures()`), not run at import
time. The corpus is still checked the moment anything reads it — which every
test that touches a fixture does — but the module stays importable by
`scripts/make-visual-fixtures.ts`, whose whole job is to rewrite the very
documents it would otherwise fail to load.
