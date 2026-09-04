## What changed

<!-- Why this change exists. Two or three sentences. -->

## Companion docs PR

<!--
REQUIRED when this PR touches src/.
Link the agency-boost-docs PR carrying the spec and manual updates, or write
`docs:none` with a one-line justification for a pure refactor.
CI fails if this section is left empty. See ADR-0001.
-->

## Definition of Done

- [ ] Implementation
- [ ] Tests — unit, integration, a cross-tenant negative for every scoped route,
      positive **and** negative permission tests per role
- [ ] Development documentation updated (companion PR above)
- [ ] Manual book updated for **every** affected role, derived from
      `docs/00-product/roles-and-permissions.md`
- [ ] Coverage ratchet holds (global 80% / domain 95% / tenancy + permissions 100% branch)
