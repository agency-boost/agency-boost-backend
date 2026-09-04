# AgencyBoost — backend

NestJS API for a multi-tenant SaaS. **This is a git submodule** of the `agency-boost` superproject (ADR-0009) — a complete, independent repository (`agency-boost-backend`).
The documentation that governs it lives in the superproject one level up: `../docs/`, with the working
rules in `../.claude/`.

Read `../CLAUDE.md` first. In particular:

- **[Never commit](../.claude/rules/no-auto-commit.md)** — propose a message; the user commits.
- **[Docs and tests ship with the change](../.claude/rules/docs-and-tests-required.md)**.
- **[Domain invariants](../.claude/rules/domain-invariants.md)** — not style preferences.

## Stack

NestJS · MongoDB (Mongoose) · Cloudinary · Jest · GitHub Actions.

## The rules that bite here

**Tenant scoping.** Every tenant-scoped document has a required `kpmId`, leading every compound
index. Queries go through `TenantScopedRepository`, which injects it from request context. **A
service that injects a Mongoose model directly is a defect**, even when the query happens to be
correct. Cross-tenant reads use the explicitly named unscoped method.

**Identity vs participation.** `users` is global. `memberships` is per `(user, KPM)`. The
**membership `_id`** is the foreign key on every per-user document — never `userId`, never a name.

**Config by code.** Tenant configuration is referenced by stable semantic code, never by display
position. Config is archived, never deleted.

**Hierarchy is append-only.** Leader edges carry `validFrom` / `validTo`.

**Soft delete everywhere.** `deletedAt` on every collection. Erasure is a deliberate, audited,
cascading operation.

**Time and money.** Inject the clock port — never `new Date()` in a service. Day boundaries resolve
in the tenant timezone. Money is integer minor units (IDR sen) with an explicit currency.

**404, not 403,** for a resource in another tenant. A `403` confirms the id exists.

## Layout

```
src/
├── domain/constants/     the single source for every threshold — never re-declare one
├── common/               guards, interceptors, filters, the clock port, the tenant repository
├── modules/<module>/     controller · service · repository · dto · schemas · __tests__
└── main.ts
```

## Working

Use the `backend-module-scaffold` skill for a new module and `add-feature` for any change.

Tests: unit for every rule, integration per endpoint, a cross-tenant negative for every scoped route,
positive and negative permission tests per role. Ratchet: global ≥80%, domain ≥95%, tenancy and
permissions **100% branch**.

Every API change regenerates the OpenAPI document and updates `../docs/02-specs/`. A PR touching
`src/` must name its companion superproject PR or CI fails, and after merging here the superproject
needs a **pointer bump** recording which commit of this repository belongs with those docs.
