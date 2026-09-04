# agency-boost-backend

NestJS API for AgencyBoost, a multi-tenant SaaS for insurance agency offices (KPM).

**The documentation that governs this repository lives in `agency-boost-docs`**, checked out one
level up as `../docs/`, with the working rules in `../.claude/`. Start at
[`../CLAUDE.md`](../CLAUDE.md) and [`backend/CLAUDE.md`](CLAUDE.md).

## Stack

NestJS · MongoDB (Mongoose) · Cloudinary · Jest · GitHub Actions

## Setup

See `../docs/03-engineering/local-development.md`. In short:

```bash
pnpm install
cp .env.example .env      # keys documented in ../docs/03-engineering/environments-and-configuration.md
pnpm seed:demo
pnpm dev                  # http://localhost:3001, OpenAPI at /api/docs
```

## The rules that bite here

- **Never commit from Claude** — it proposes a message; a human commits.
- **Queries go through `TenantScopedRepository`.** A service injecting a Mongoose model directly is a
  defect, even when the query is correct.
- **`membershipId` is the foreign key** on per-user data — never `userId`, never a name.
- **404, not 403**, for a resource in another tenant.
- Money in integer minor units; day boundaries in the tenant timezone.

Full list: `../.claude/rules/domain-invariants.md`.

## Status

Scaffolding only. Implementation begins at Phase 1 —
see `../docs/05-delivery/phases/phase-01-engineering-foundation.md`.
