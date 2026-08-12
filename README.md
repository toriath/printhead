# PRINTHEAD

A finite idle game about a 3D printer that eventually prints everything.
The binding specification is [`docs/printhead-spec-v0.4.md`](docs/printhead-spec-v0.4.md).

> **Status:** M4 — slots and scale. The game is playable in a browser through
> phases 0–2: assemble printer #1 piece by piece, load the slot, print, watch the
> pity timer fill and a print fail, recycle the scrap, climb the machine tree,
> unlock PETG behind the heated bed, trade filament on a moving market, buy your
> way out of the friction with automation — and then outgrow your first bay,
> buy a second, spread the fleet across the rack, put a bay on a print rota and
> commit the run to Farm or Goliath. It installs as a PWA, autosaves to
> IndexedDB and shows a "welcome back" summary. `VisualState` is frozen at v5;
> saves are at v4. Designs and prestige land in M5.

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

Other scripts: `pnpm mutation` (Stryker on `systems/`, `curves/` and `visual/`
— a full run is ~45 minutes, so CI gives it [its own job](.github/workflows/ci.yml)
rather than holding the fast feedback behind it),
`pnpm balance:sim [botId]`, `pnpm balance:sweep`, `pnpm balance:tune`,
`pnpm balance:report` (see [Balancing](#balancing)),
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
v5 by a strict zod schema plus the fixture corpus in
`packages/core/src/visual/__fixtures__/`, which the renderer's own tests render.

- one animated machine **per slot**, never per printer, with an `×N` badge;
- empty and locked bays as faint outlines, up to the hard maximum of four (§4);
- the **Goliath** layout replaces the whole rack with one large printer (§5B).
  The renderer never learns the fork's id: the projection publishes a `goliath`
  flag derived from the branch's own drawing instruction in `forks.json`;
- a bay's print rota is a strip of pips beneath it, the loaded entry filled in;
- machine tiers change the SVG — frame acrylic/aluminium/steel, nozzle
  brass/hardened/glowing, bed tape/heated/auto-level (§5A), snapshot-tested;
- the idle print-head sweep is CSS keyframes desynchronised by the projection's
  `phaseOffset`, so the renderer never needs a clock of its own;
- a bay mid-changeover shows the purge on its progress bar, and the pity charge
  is a hairline beneath it (§3, §7.1).

### The economy (spec §2, §3, §5, §7)

- **Materials are strategies chosen by data.** PLA is cheap, infinite and
  crash-prone; PETG is the balanced workhorse behind the heated bed; resin is
  slow, reliable and behind the SLA unit; metal is a stub for M5. What makes
  them different is entirely numbers in `materials.json` — plus
  `requiresUpgradeId`, which is how the machine tree gates them.
- **Failure is a deterministic pity timer, never a dice roll** (§7.1). Each
  print adds a charge to its slot; when the charge crosses the threshold that
  print fails and yields Scrap. The renderer draws the charge as a hairline
  under the bay, because a failure you can see coming is a mechanic and one you
  cannot is a slot machine.
- **The recycler conserves value, not grams.** Scrap carries a banked money
  value, and recycling returns `yieldFraction` of *that* — so turning PLA swarf
  into resin hands back a pittance of resin rather than minting it.
- **The market is sine + seeded noise + supply response** (§7.2), and a trade
  pays its own slippage: the pressure a buy creates is applied *before* the buy
  is priced. Together with the spread that is what makes a buy/sell round trip
  strictly lossy, which is asserted as a property rather than hoped for.
- **Changing a slot's configuration costs time and a purge** (§3) — and
  abandons the batch in flight, because an auto-restarting slot is never idle
  and "only when idle" would have meant "never".

### Slots and scale (spec §4, §5B)

- **Bays hold a fixed number of machines** (`start.printersPerSlot`). This is
  what makes a config slot worth buying: a batch's duration does not depend on
  how many printers run it, so without a ceiling a second bay would only be a
  second recipe and splitting the same fleet across two bays would produce
  exactly the same parts per minute. With a ceiling, bays *are* fleet capacity,
  and "how do I allocate my fleet across slots?" has an answer.
- **Slots go 1 → 2 → 3 → 4 and stop.** The list lives in `slots.json`, one entry
  per bay with its price, its phase and its gates; the hard maximum is derived
  from that list plus `start.slotCount`, so the cap and the unlocks that reach
  it can never disagree. Slot 3 wants an enclosure and slot 4 wants a Plate —
  which nothing before M5 can mint, so it is prestige-gated in the literal sense.
- **`ASSIGN_PRINTER` conserves the fleet.** Machines walk between bays; the sum
  across bays always equals the machines owned, asserted as a property. Pulling
  machines out of a running bay *shrinks its batch* rather than refunding it —
  the filament was spent when the batch started.
- **Print rotas are the auto-changeover automation's feature** (§5B/§5C). A rota
  is a list of `{ material, object, batches }` on a bay; it turns when a batch
  finishes, through the same changeover a hand-driven switch pays for, and only
  while the automation is installed *and* switched on. Switch it off and the
  friction comes back.
- **Farm or Goliath, once per run** (§5B). Both branches are ordinary content: a
  price, gates, the same effect records the machine tree uses, a bay cap and a
  drawing instruction. Goliath is simply the branch that caps the rack at one
  and lets that single bay hold the whole fleet — committing to it *melts the
  rack down*, carrying the machines into the first bay and stripping the rest.
  The reducer only ever writes `forkId` while it is `null`, so exclusivity is a
  property of the shape rather than a rule someone has to remember.

### The dev editor panel (spec §14)

`pnpm --filter @printhead/app dev`, then the **Editor** button, bottom right.

Its forms are generated from the zod schemas, so a new content file appears in
it with zero editor code. Edits hot-apply through the same validator the game
uses and keep the last good set on rejection; **Write to disk** posts to a
dev-only Vite middleware that re-validates before touching a file. Time controls
pause, warp ×1/×10/×100 *on top of* pace, and jump the FSM into any phase.

The panel is behind `import.meta.env.DEV` **and** a dynamic import, so it is its
own chunk and a production build drops it — `smoke.prod.spec.ts` fetches every
shipped script and asserts its markers are absent.

### E2E and the dev test seam

At `targetHours: 8` the intro takes five real minutes, which no browser test
can wait for. Dev builds therefore expose `window.__PRINTHEAD__` (spec §14):
it freezes the platform clock and lets a test step the frame loop. Nothing else
is faked — the reducer, the pace mapping and the phase gates are the shipped
ones, and a warped intro still needs the same seven clicks. The seam lives
behind `import.meta.env.DEV`, and `smoke.prod.spec.ts` asserts it is absent
from the production bundle.

## Balancing

Numbers are never guessed; they are **fitted by the tools and shipped as data
diffs** (spec §12, §19). Every command runs the real `core` headlessly.

```bash
pnpm balance:sim [botId]     # one bot vs. the §6 phase budgets, with blockers
pnpm balance:sweep <pointer...> [--steps 5] [--spread 2] [--samples n]
pnpm balance:tune [--phases intro,bench,farm] [--write]
pnpm balance:report [--date YYYY-MM-DD] [--sweep sweep.csv]
```

- **Bots** (§12.1): `greedy-spender`, `balanced`, `idle-heavy` and the `idle`
  floor. They are one policy with two knobs — spend-first vs. upgrade-first, and
  how often the player looks at the game — so a new mechanic reaches all three
  at once instead of being wired into one and forgotten in the others.
  `balanced` is the reference the CI gate measures.
- **Wait walls** (§12.2): a stretch with no *meaningful* action available —
  nothing to attach, nothing affordable, no idle machine to feed. Watching a
  print finish is not a dead zone; having nothing to click is. Budgeted per
  phase in `pacing.json` and asserted in CI alongside the phase times.
- **Sweep** (§12.3): grid or deterministic random search over content fields
  addressed by pointer, run across worker processes, CSV out. Each axis brackets
  whatever the content currently holds, so a sweep never drifts away from the
  shipped balance.
- **Tune** (§12.4): `tunePhase` bisects one field against one phase;
  `hillClimb` moves several at once against the whole timeline *and* the
  wait-wall budgets, because the cheapest way to shorten a phase is to make
  everything affordable at once, which empties its middle. `--write` applies the
  result to `packages/core/content/` as a reviewable diff.
- **Report** (§12.5): markdown plus SVG charts into
  `docs/balance-reports/<date>/`. The current one is
  [`2026-08-12`](docs/balance-reports/2026-08-12/report.md).

```
phase           actual   budget   window
intro             5.0      5.0   4.0..6.0
bench            25.9     30.0   24.0..36.0
farm             80.1     80.0   64.0..96.0
```

> **Read the green light correctly.** `intro`, `bench` and `farm` are gated on
> real mechanics — assemble, print, sell; four printers, two machine nodes and a
> recycler run; fourteen printers, six nodes and three automations. Phases
> `studio`…`end` still advance on `phaseDesignMinutes` alone, so they sit on
> budget by construction and will stay green no matter what the economy does.
> They become meaningful gates as M5–M6 add the mechanics behind them, and the
> last phase absorbs any drift from the earlier ones because the run stops at
> the total budget rather than at a gate of its own.
>
> The tools know which is which without being told: a phase whose only
> requirement is `phaseDesignMinutes` **is** a placeholder (`isPlaceholderPhase`),
> and the wait-wall gate is scoped to the rest. Once the reference player has
> bought everything M4 sells, the detector correctly reports dead zones in those
> empty phases; raising their budgets would make the report green and the game
> no better, so the overrun is asserted instead and the assertion breaks — on
> purpose — the moment M5 gives the studio something to do.
>
> The bots disagree with each other, and that is the point. `greedy-spender`
> buys capacity the instant it can afford it; in M3 that stalled it, because
> printers stayed cheap and it never saved for the SLA unit. Bays now cap the
> fleet, so its reflex runs into a ceiling, it is *forced* to buy a config slot,
> and it finishes the arc — in 57 farm-minutes against the reference player's
> 80, with an order of magnitude more prints. It also takes the other side of
> the fork, so between the two of them both branches get played.

## Layout

```
packages/core       pure TS simulation — content/, engine/, state/, systems/,
                    curves/, visual/, save/, rng/ (no DOM, no Math.random, no Date.now)
packages/renderer   React SVG, a pure function of VisualState
packages/app        shell, HUD, store bridge, engine loop, autosave, PWA
packages/editor     dev-only editor panel: schema-generated inspector, time controls
packages/platform   storage (IndexedDB) + clock + lifecycle facade (web / Tauri)
tools/balance       headless harness, bots, wait walls, sweep, tuner, report
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
