# Migrations

Forward-only, versioned, idempotent — the convention in
[`docs/03-engineering/environments-and-configuration.md`](../../../docs/03-engineering/environments-and-configuration.md).

One file per migration, named `NNNN-kebab-case.ts`, exporting `up(db)`. Run by `deploy.yml` before
the new image starts. Never edited after it has run anywhere: a correction is a new migration.

**Every one must be safe to run twice.** The deploy workflow may retry, and a developer will run it
by hand against their own database.

```bash
pnpm migrate            # every pending migration, in order
```

## Recorded runs

Each migration's `up` returns what it did, and `run.ts` prints it — the deploy log is the record.
`0026-moc-persistency` (Phase 18, D-moc) prints `{ added, current, cleared }`: the MOC rules given the
persistency criterion, those that already carried it, and those cleared of metrics registered since.


`0027-campaign-kinds` (Phase 18.5, D-fields) prints `{ updated, current }`: the campaigns given the fields the
agent's card draws — seasonal, over their own dates, open to everybody, the default poster, no blurb — and those
that already carried them.