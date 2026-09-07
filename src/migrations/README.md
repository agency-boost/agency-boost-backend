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
