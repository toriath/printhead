# Save fixture corpus

Every released save schema version must load forever (spec §13). Each
`save-v<N>.json` here is a real save the game produced at version `N`.

**These files are frozen.** Once a version has shipped, never edit or
regenerate its fixture — that is the one thing that would make the corpus stop
proving anything. If a fixture no longer loads, the fix is a migration in
`../migrations.ts`, not an edit here.

Adding a fixture for a *new* version:

```bash
pnpm tsx scripts/make-save-fixture.ts   # writes save-v<SAVE_SCHEMA_VERSION>.json
```

The generator plays the intro and part of the bench loop through the real
reducer, so the fixture is a save the game actually produces rather than a
hand-written guess. Its exact numbers depend on the content set at the time of
generation, which is fine and expected — the fixture records one historical
save, not the current balance.
