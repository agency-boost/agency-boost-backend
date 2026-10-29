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
`0030-org-level-leader-tier` (Phase 18.8, P18.8-T1) prints `{ senior, associate, none, membersOnCustomRungs }`: the
rungs given *Senior Leader* (every `AB`), *Associate Leader* (every `AAB`) and *Not a leader* (every other code), and
the live memberships on a rung outside the default ladder, left as they are — 0 is expected. A second run tiers none.
`0031-lead-position` (Phase 18.8, P18.8-T7) prints `{ placed, owners }`: the leads given a place in their owner's
list — newest registration first, below any lead the new code had already placed — and how many lists they were in.
A second run places none.
`0032-cascade-item-words` (Phase 18.8, P18.8-T8) prints `{ types, snapshots, templates }`: the activity types that
took the client's words for items 3, 7 and 8 (ADR-0160 §1) — only those still holding a seeded wording, item 7's
note dropped where it was still the seeded one — and the newest snapshots and company templates rewritten the same
way. No version moves. A second run writes none.
`0033-ratio-benchmarks-iv` (Phase 18.8, P18.8-T9) prints `{ ratios, snapshots, templates }`: the ratio definitions
given the client's benchmarks — 30%, 30%, 1.00 and 50% — and *Set appointment to meeting*'s name and percent unit,
each field only where it still held the seeded value (ADR-0160 §2), and the newest snapshots and `ratio_set` templates
moved the same way. No version moves. A second run moves none.
`0034-activity-bindings` (Phase 18.9, P18.9-T2) prints `{ offices, snapshots, templates }`: the offices given an
activity binding — `LEADS_CONTACTED`, `SELL_PRESENTATION` and `SELL_SUBMISSION`, one per cascade role, what every
count read by constant until then (ADR-0163 §1) — the newest snapshots given the office's binding as their record,
and the `activity_taxonomy` company templates, draft and published, given the same three as `payload.bindings`. Each
only where none is held. A second run writes none.
`0035-blank-preferred-name` (Phase 18.8, P18.8-T15) prints `{ cleared }`: the accounts whose preferred name was an
empty string or only whitespace — what the profile saved for an empty field until the API stored `null` — given
`null`, so their full name shows wherever a name is. A real preferred name is not touched. A second run clears none.
`0036-company-kind` (Phase 18.9, P18.9-T3) prints `{ updated }`: the companies given `kind: 'insurer'` — every one
written before the field, each made for an insurer (ADR-0164 §1). A company with a kind keeps it. A second run
updates none.
`0037-template-company` (Phase 18.9, P18.9-T3) prints `{ created, rungs, products, carrierRules, playbook, kinds,
template }`: whether it made the *Template* company — kind `template`, slug `template`, the *Template library*
(ADR-0164 §2) — and what it wrote for it: the default ladder with its leader tiers, the 31 products, the carrier
rules, the recruitment playbook, and **Default template**, the default, each of the seven kinds a published version
1 of the AgencyBoost defaults. The parts first, the company last, all under fixed ids, so a run that stopped part-way
is finished by the next. Once the company exists it writes nothing (`created: false` and zeros). **It stops the run**
when an insurer already holds the slug `template`, naming it.
`0038-first-status-wording` (Phase 18.95, P18.95-T9) prints `{ statuses, snapshots, templates }`: the recruitment
pipelines whose first status, `NOT_APPROACHED`, took the sales pipeline's words, *Not yet approached* (ADR-0167 §10,
UI-027) — only those still holding the seeded *Not approached*, archived rows included, soft-deleted ones not — and
the newest snapshots and `lead_pipeline` company templates, draft and published, the Template company's *Default
template* among them, rewritten the same way. Found by code within the recruitment pipeline; an Owner's own label,
the sales pipeline's status and another code holding the same words are not touched. No version moves. A second run
writes none.
`0039-product-name-placeholder` (Phase 18.95, P18.95-T6) prints `{ cleared }`: the office product rows whose display
name was exactly the company's name followed by *" (nama kami)"* — the demo seed's rename, which the client read as a
placeholder on the Product Catalog (UI-023) — given back to the company's name (`$unset`, the version moved once).
A name an Owner typed, a row of another product and a soft-deleted row are not touched. A second run clears none.
`0040-membership-join-date` (Phase 18.96, P18.96-T2) prints `{ newHires, existingAgents, waiting }`: the memberships
with no `joinedAs` given a join date and a classification (ADR-0169 §6) — a `new_hire` from its activation's start date
where it has an activation, an `existing_agent` from `joinedAt` as an office date where it has none — and the pending
ones nobody has let in, left for their approval to write. A second run classifies none; the pending stay waiting.
`0042-membership-first-sale` (Phase 18.96, P18.96-T4) prints `{ written, unchanged }`: the memberships given a first
sale, or an earlier one than they held (ADR-0171 §1) — a sales lead's first *Paid and issued* day, else the first month
the production file shows a policy — and those whose first sale stood. Never later, so a second run writes none. There
is no `0041`: Phase 18.96-T3 held the number and needed no migration.
*Both, the permission review of 2026-10-27:* a value an Owner typed that happens to equal the seeded one — *Not
approached* for 0038, exactly *"{name} (nama kami)"* for 0039 — cannot be told from it and is rewritten too. Accepted:
the words are the default's own.
`0043-leader-meeting-target-rates` (Phase 18.97, P18.97-T1 AC-11) prints `{ meetings, rates, none, kept, current }`: the
forum's meetings whose *Monthly Target* cells it read, and each cell's reading — a rate where it read *"{n} ({r} @ unit)"*
(the rate *r*, in sen for *APE*, ADR-0175 §4), no target for *TBD* or an empty cell, the text kept as typed for anything
else — and the cells already a rate. Only the five rows that take one; a *New AA* cell, the scorecard, the version and
every timestamp are left as they are. A second run reads every cell as `current`. No frozen scorecard is migrated:
it is read tolerantly and no key of it is renamed (ADR-0175 §8, P18.97-T1 AC-19), so the number held for that, `0044`,
goes unused.
`0045-training-category-descriptions` (Phase 18.97, P18.97-T4 AC-9) prints `{ categories, snapshots, templates }`: the
training categories given their one line of description (ADR-0176 §9, UI-031) — Sales where it still read exactly
*"Structured modules — tracked here."*, and *Product*, *Recruiting*, *Team Management*, *Soft Skills* and *Company and
KPM* where they still had none and had never been edited (version 1), archived rows included — then each office's newest
snapshot rewritten the same way, and the `training_taxonomy` company templates, draft and published, whose Sales still
held the seeded sentence (the Template company's *Default template* among them). An office's own words, a description an
Owner cleared, and a template somebody edited are not touched. No version moves. A second run writes none. There is
no `0044`: it was held for P18.97-T1's frozen scorecards, which are read tolerantly and needed none (AC-19).
`0046-default-template-in-indonesian` (Phase 18.98, P18.98-T7; OD-238, ADR-0179 §5) prints `{ templates, fields }`: the
Template company's *Default template* (`TEMPLATE_LIBRARY`'s fixed ids) written in Bahasa Indonesia — the versions,
draft and published, of its six kinds that carry words (`ratio_set` is not one: a ratio's name is a metric name, kept
English) it rewrote, and how many fields. A field is rewritten only where it still holds exactly the English the seed
gave before (`SEEDED_*_BEFORE_OD_238`), found by code — a lead status by code within its pipeline — and takes the seed's
Indonesian. A field the Super Admin edited keeps their words; an office's own configuration, its snapshots, an insurer's
templates and every template saved from an office are copies, never links (ADR-0164), and are not touched. No version
moves. A second run, and a run on a database `0037` made from today's seed, write none. `0038` and `0045` write the
English they were written for since this change, so an office still holding the older seeded words is given the English,
as it would have been — never the Indonesian.
