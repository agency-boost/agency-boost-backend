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
