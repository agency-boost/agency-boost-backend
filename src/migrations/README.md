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


`0027-campaign-kinds` (Phase 18.2, D-fields) prints `{ updated, current }`: the campaigns given the fields the
agent's card draws — seasonal, over their own dates, open to everybody, the default poster, no blurb — and those
that already carried them.
`0030-org-level-leader-tier` (Phase 18.5, P18.5-T1) prints `{ senior, associate, none, membersOnCustomRungs }`: the
rungs given *Senior Leader* (every `AB`), *Associate Leader* (every `AAB`) and *Not a leader* (every other code), and
the live memberships on a rung outside the default ladder, left as they are — 0 is expected. A second run tiers none.
`0031-lead-position` (Phase 18.5, P18.5-T7) prints `{ placed, owners }`: the leads given a place in their owner's
list — newest registration first, below any lead the new code had already placed — and how many lists they were in.
A second run places none.
`0032-cascade-item-words` (Phase 18.5, P18.5-T8) prints `{ types, snapshots, templates }`: the activity types that
took the client's words for items 3, 7 and 8 (ADR-0160 §1) — only those still holding a seeded wording, item 7's
note dropped where it was still the seeded one — and the newest snapshots and company templates rewritten the same
way. No version moves. A second run writes none.
`0033-ratio-benchmarks-iv` (Phase 18.5, P18.5-T9) prints `{ ratios, snapshots, templates }`: the ratio definitions
given the client's benchmarks — 30%, 30%, 1.00 and 50% — and *Set appointment to meeting*'s name and percent unit,
each field only where it still held the seeded value (ADR-0160 §2), and the newest snapshots and `ratio_set` templates
moved the same way. No version moves. A second run moves none.
`0034-activity-bindings` (Phase 18.6, P18.6-T2) prints `{ offices, snapshots, templates }`: the offices given an
activity binding — `LEADS_CONTACTED`, `SELL_PRESENTATION` and `SELL_SUBMISSION`, one per cascade role, what every
count read by constant until then (ADR-0163 §1) — the newest snapshots given the office's binding as their record,
and the `activity_taxonomy` company templates, draft and published, given the same three as `payload.bindings`. Each
only where none is held. A second run writes none.
`0035-blank-preferred-name` (Phase 18.5, P18.5-T15) prints `{ cleared }`: the accounts whose preferred name was an
empty string or only whitespace — what the profile saved for an empty field until the API stored `null` — given
`null`, so their full name shows wherever a name is. A real preferred name is not touched. A second run clears none.
`0036-company-kind` (Phase 18.6, P18.6-T3) prints `{ updated }`: the companies given `kind: 'insurer'` — every one
written before the field, each made for an insurer (ADR-0164 §1). A company with a kind keeps it. A second run
updates none.
`0037-template-company` (Phase 18.6, P18.6-T3) prints `{ created, rungs, products, carrierRules, playbook, kinds,
template }`: whether it made the *Template* company — kind `template`, slug `template`, the *Template library*
(ADR-0164 §2) — and what it wrote for it: the default ladder with its leader tiers, the 31 products, the carrier
rules, the recruitment playbook, and **Default template**, the default, each of the seven kinds a published version
1 of the AgencyBoost defaults. The parts first, the company last, all under fixed ids, so a run that stopped part-way
is finished by the next. Once the company exists it writes nothing (`created: false` and zeros). **It stops the run**
when an insurer already holds the slug `template`, naming it.
`0038-first-status-wording` (Phase 18.7, P18.7-T9) prints `{ statuses, snapshots, templates }`: the recruitment
pipelines whose first status, `NOT_APPROACHED`, took the sales pipeline's words, *Not yet approached* (ADR-0167 §10,
UI-027) — only those still holding the seeded *Not approached*, archived rows included, soft-deleted ones not — and
the newest snapshots and `lead_pipeline` company templates, draft and published, the Template company's *Default
template* among them, rewritten the same way. Found by code within the recruitment pipeline; an Owner's own label,
the sales pipeline's status and another code holding the same words are not touched. No version moves. A second run
writes none.
`0039-product-name-placeholder` (Phase 18.7, P18.7-T6) prints `{ cleared }`: the office product rows whose display
name was exactly the company's name followed by *" (nama kami)"* — the demo seed's rename, which the client read as a
placeholder on the Product Catalog (UI-023) — given back to the company's name (`$unset`, the version moved once).
A name an Owner typed, a row of another product and a soft-deleted row are not touched. A second run clears none.
`0040-membership-join-date` (Phase 18.8, P18.8-T2) prints `{ newHires, existingAgents, waiting }`: the memberships
with no `joinedAs` given a join date and a classification (ADR-0169 §6) — a `new_hire` from its activation's start date
where it has an activation, an `existing_agent` from `joinedAt` as an office date where it has none — and the pending
ones nobody has let in, left for their approval to write. A second run classifies none; the pending stay waiting.
`0042-membership-first-sale` (Phase 18.8, P18.8-T4) prints `{ written, unchanged }`: the memberships given a first
sale, or an earlier one than they held (ADR-0171 §1) — a sales lead's first *Paid and issued* day, else the first month
the production file shows a policy — and those whose first sale stood. Never later, so a second run writes none. There
is no `0041`: Phase 18.8-T3 held the number and needed no migration.
*Both, the permission review of 2026-10-27:* a value an Owner typed that happens to equal the seeded one — *Not
approached* for 0038, exactly *"{name} (nama kami)"* for 0039 — cannot be told from it and is rewritten too. Accepted:
the words are the default's own.
`0043-leader-meeting-target-rates` (Phase 18.9, P18.9-T1 AC-11) prints `{ meetings, rates, none, kept, current }`: the
forum's meetings whose *Monthly Target* cells it read, and each cell's reading — a rate where it read *"{n} ({r} @ unit)"*
(the rate *r*, in sen for *APE*, ADR-0175 §4), no target for *TBD* or an empty cell, the text kept as typed for anything
else — and the cells already a rate. Only the five rows that take one; a *New AA* cell, the scorecard, the version and
every timestamp are left as they are. A second run reads every cell as `current`. No frozen scorecard is migrated:
it is read tolerantly and no key of it is renamed (ADR-0175 §8, P18.9-T1 AC-19), so the number held for that, `0044`,
goes unused.
`0045-training-category-descriptions` (Phase 18.9, P18.9-T4 AC-9) prints `{ categories, snapshots, templates }`: the
training categories given their one line of description (ADR-0176 §9, UI-031) — Sales where it still read exactly
*"Structured modules — tracked here."*, and *Product*, *Recruiting*, *Team Management*, *Soft Skills* and *Company and
KPM* where they still had none and had never been edited (version 1), archived rows included — then each office's newest
snapshot rewritten the same way, and the `training_taxonomy` company templates, draft and published, whose Sales still
held the seeded sentence (the Template company's *Default template* among them). An office's own words, a description an
Owner cleared, and a template somebody edited are not touched. No version moves. A second run writes none. There is
no `0044`: it was held for P18.9-T1's frozen scorecards, which are read tolerantly and needed none (AC-19).
`0046-default-template-in-indonesian` (Phase 18.10, P18.10-T7; OD-238, ADR-0179 §5) prints `{ templates, fields }`: the
Template company's *Default template* (`TEMPLATE_LIBRARY`'s fixed ids) written in Bahasa Indonesia — the versions,
draft and published, of its six kinds that carry words (`ratio_set` is not one: a ratio's name is a metric name, kept
English) it rewrote, and how many fields. A field is rewritten only where it still holds exactly the English the seed
gave before (`SEEDED_*_BEFORE_OD_238`), found by code — a lead status by code within its pipeline — and takes the seed's
Indonesian. A field the Super Admin edited keeps their words; an office's own configuration, its snapshots, an insurer's
templates and every template saved from an office are copies, never links (ADR-0164), and are not touched. No version
moves. A second run, and a run on a database `0037` made from today's seed, write none. `0038` and `0045` write the
English they were written for since this change, so an office still holding the older seeded words is given the English,
as it would have been — never the Indonesian.
`0047-leaving-decides-no-3m` (Phase 18.11, P18.11-T3; UI V1, UI-023, the owner's D-24) prints `{ cleared, kept }`: the
left new hires whose 3M result a leaving had kept on or before their day 90 — given back to their first sale and join
date, `activation3M` and `activation3MLockedAt` set to `null`, `leftAt` kept — and the left new hires whose result was
kept after day 90, as anybody's is, left as they are. Office by office, in each office's timezone. A second run clears
none.
`0048-default-template-motivation` (Phase 18.11, P18.11-T10; UI V1, UI-063, the owner's 30 Oct) prints
`{ templates, current }`: the versions of the Template company's Default template given the owner's seventh training
category, *Motivation* (`MOTIVATION_CATEGORY`, *Motivasi*), after *Team Management*, and those already holding one coded
`MOTIVATION` — today's `0037`, or the Super Admin's own — left as they are. Never an office's taxonomy or snapshot, an
insurer's template or a template saved from an office (ADR-0018). No version moves. A second run writes none.
`0049-calendar-all-day` (Phase 18.11, P18.11-T15) prints `{ trips, timed }`: the calendar entries given `allDay` — every
trip written before the field `true`, as Travel was all-day by its type, every other entry `false` (UI-104 point 8, a
trip with times). A row that already says either keeps it. A second run writes none.
`0050-kpm-code-unique-among-live` (Phase 19, P19-T3) prints `{ dropped, created }`: whether it built
`one_live_code_per_company` — a KPM code unique within its company among offices that are not deleted (ADR-0191 §3, §5)
— and dropped `companyId_1_code_1`, which counted deleted offices too, so a deleted office or one an approval undid gave
its code back to nobody. The new index first, so there is never a moment without the rule. A second run, or a database
with no `kpms`, does nothing (`{ dropped: false, created: false }`).
`0051-moc-ape-key` (Phase 19.3, P19.3-T1; ADR-0201 §1, the owner's D5 *"APE is APE"*) prints `{ rules, templates,
current }`: the live `qualificationRules` of kind `moc` whose criteria named `NET_APE`, given `MOC_APE` in its place —
the comparator, the threshold, the unit and every other criterion kept, no `effectiveFrom` written, `NET_APE` taken out
of `waitingOnMetrics` — and the `campaign_kinds` company templates, draft and published, whose `moc` rules named it,
renamed the same way, no version moved; then those that named it no longer. A production club, a promotion path, a
soft-deleted rule and every other template kind are left as they are (a stored `NET_APE` reads `MOC_APE` anyway,
`RENAMED_METRIC_KEYS`). A second run renames none.
`0052-kpm-setup-running-offices` (Phase 19.3, P19.3-T2; UI-149, Overview R2) prints `{ marked, current, setup }`: every
office already **running** — an active member besides its Owner and a committed production upload — given a
`kpmSetupMarks` row `via: 'migration'` for each of the setup card's four settings pages (*Branch info*, *Activity types*,
*Activation checklist*, *Products*), so *Siapkan KPM* does not ask it to confirm what its people already use; then the
running offices marked already; then the offices not running yet, left for their Owner. Steps 5 to 7 stay derived. A
mark already there is kept, whatever made it, and no page's data is touched. A second run marks none.
`0053-product-kind-and-currency` (Phase 19.4, P19.4-T4; ADR-0209 §1, §8) prints `{ kind, attachesTo, currencies }`: every
product written before the fields given `kind: 'base'`, `attachesTo: []` and `currencies: ['IDR']` — what it always was,
a standalone product sold in rupiah. A product that states any of them keeps it, no version moves, and agents' catalogue
reads the same before and after. A second run writes none.
`0054-product-objection-cards` (Phase 19.4, P19.4-T4; ADR-0209 §9, B1-1) prints `{ products, split, empty, overrides }`:
each product's objection pair, `objectionTheySay` and `objectionYouSay`, as `defaultAttackPlan.objections` — the merged
*`1. "…" → …`* text split into cards (`splitObjections`), anything else one card — a new version each, the original in
`auditLog` as `product.objections_split`; `split` the ones that became more than one card; `empty` the products with
nothing written, given `[]` and no version. Then `overrides`: offices' rows whose draft or approved copy held a pair, as
cards — a side the office never replaced is the company's beside it — audited `kpm_product.objections_split`, the review
state kept. The offices go first, while the company's pair is still there. A second run finds no pair and writes none.
`0055-view-as-only` (Phase 19.4, P19.4-T2; ADR-0206 §5, UI-151) prints `{ ended }`: every support session still open
(`endedAt: null`, not deleted) that was started as a **setup** session or **elevated** to write (`purpose: 'setup'` or
`readOnly: false`) ended at the deploy's time with `endReason: 'view_as_only'`, and an `impersonation.ended` entry in its
office (`after: { reason: 'view_as_only', sessionId, startedBy }`, the actor this job). An expired one is ended too, so
the Owner's log never shows a start with no end. A session that only looks runs on; `purpose`, `readOnly`, `writeScope`
and the elevation fields stay on each row as history. `AuthGuard` refuses a surviving row of either kind regardless
(`401`). A second run ends none.
`0056-playbook-into-template` (Phase 19.4, P19.4-T5; ADR-0210 §5, B1-11) prints `{ moved, versions, current,
noTemplate, skipped, ownKept }`: the company recruitment playbooks moved into their templates — each record's words, as a
published `recruitment_playbook` version continuing the record's `version` (`migratedFrom: { recruitmentPlaybookId,
version }`), in the company's **default** template and in every other template of the company a live KPM was made from
— and how many template versions that wrote; the records already moved (`migratedTo` set); those of a company with no
default template, left for a later run; those of a company created since T5 (`companies.playbookInTemplates`), whose words
`0025` wrote and which are never moved; and templates that already held a playbook of their own, kept. Each moved record
is marked `migratedTo: { templateId, version }` (the default's) and stays, read by nothing. A second run moves none.
`0057-advanced-analytics-v1` (Phase 19.5, P19.5-T1; ADR-0214 §9) prints `{ written, current, drafts, reports }`: the
templates given a published *Advanced analytics* version 1 — today's seven upload columns, each `required: false` with
its issued headers as aliases, `unknownAgent: 'reject'` — those that already held the section, and the Prudential drafts
written (`^[0-9]{8}$`, OD-266 Q3). Each report names the template, its KPMs, how many registered agent codes they hold,
the pattern chosen — the first of `^\d{3,32}$`, `^[A-Za-z0-9-]{1,32}$` and `^.{1,64}$` every one of those codes matches —
and the columns' `effectiveFrom`, the earliest month any of its KPMs holds a figure. A second run writes none.
`0059-training-title-split` (Phase 19.6, P19.6-T4; ADR-0220 §3, UI-161) prints `{ templateVersions, drafts, kpms,
republished, seededFromMoved, lines }`: every *"Name: description"* skill and module split once at its first colon
followed by a space (`splitTrainingTitle`) — each template's newest published `training_taxonomy` as a new published
version (`createdBy: '0059-training-title-split'`), an open draft in place, renumbered past it and its `revision` moved;
every KPM's skills and modules, archived ones too, each split row a new `version` and each row left whole given
`description: null` (the ledger: a row holding `description` is never read again). Each KPM's newest published
configuration is published again, origin `{ source: 'migration' }`, with every split row whose published copy was the live
row; a KPM unchanged against the template version it was given moves its `seededFrom.training_taxonomy` to the split one.
`lines` names every split and every title left whole for a reason (`empty_half`, `too_long`), per KPM and template. No
code, progress, material, order or archived state moves. A second run writes none.
`0060-activity-short-labels` (Phase 19.8, P19.8-T4; ADR-0229 §5, MOB UI-180) prints `{ types, snapshots }`: every
office's activity type of the twelve seeded codes, archived ones too and deleted ones never, given its *Nama singkat*
from `SEED_ACTIVITY_TYPES` by code where it holds none (the key missing, `null` or blank), and each office's newest
published snapshot the same, so the working copy and what agents read agree and no publish bar speaks. An office's own
short name, and a type of its own code, are left alone. No version moves; templates are not written (a template type
without the key gives the seed's words by code when an office is provisioned or pushed). A second run writes none.
`0061-group-leader-is-a-member` (Phase 19.13, P19.13-T3; ADR-0253 §2, UI-199) prints `{ tagged, cleared, current }`:
every live group with an owner, whose owner is now its ★ group leader — a leader who is a member of it. An owner who is
an active AB or AAB of the office is tagged into the group (`tagged`; their other tags stay, and they read as the group
they lead); an owner who left, is pending, is on an Agent's rung or was erased is cleared to `null`, *Belum ada group
leader* (`cleared`); a leader owning several groups keeps the first by name and the others are cleared; an owner already
a member is `current`. Each write has its audit row, `member.tagged` or `group.updated`, named to the job, with what it
replaced. A second run writes none.
`0062-subgroup-targets-by-year` (Phase 19.13, P19.13-T3; ADR-0253 §4, UI-199) prints `{ dated, created, dropped }`: every
`analyticsTargets` row of kind `subgroup` with no `year` given the current year on its office's clock (`kpms.timezone`,
else `Asia/Jakarta`); `one_subgroup_target_per_leader_and_year` built, then `kpmId_1_kind_1_headMembershipId_1` — one row
per head — dropped. A field added and an index swapped: no row is deleted or changed otherwise. A second run does
nothing; with no `analyticsTargets` collection it does nothing.
`0063-proposal-items-carry-cara-bayar` (Phase 19.14, P19.14-T1 and T2; ADR-0254 §1, ADR-0255 §1, §2) prints
`{ proposals, items, renamed }`: every proposal that still carried the proposal-wide `channel` or `payFrequency`,
soft-deleted ones too, given the 11 November shape — each item its own `payFrequency` (the proposal's), `isSyariah` (the
proposal was *Syariah*), the insured's `gender`, `smoker`, `payTerm` and `up` as `null`, `fixedField: 'none'`, a premium
not typed as `null`, and a snapshot that is `manual` with no pay terms, the four periodic *Cara bayar* and its category's
need; the client given `ageSetOn` (the KPM's day the proposal was made) and empty `details`; `channel` and
`payFrequency` removed and kept as `migrated0063` with each item's former name — `renamed` counts the items of a
*Syariah* proposal that took their product's `syariahName`, as they showed. **No lead is touched.** A second run writes
none. **It has a `down`** (not run by `pnpm migrate`; call it by hand) that puts the 3 November shape back from
`migrated0063`.
`0065-test-accounts` (Phase 19.17, P19.17-T1; ADR-0267 §1; OD-370) prints `{ flagged, cleared, memberships }`: every
account written before `users.testAccount` decided once by its full name — beginning *FMT* or *TES IMPOR*, trimmed, any
case, whole words (`isTestAccountName`) `true`, every other `false` — and then every membership of a flagged account, any
office and status, given `testAccount: true`. **Only an account with no value is read**, so a flag set or cleared by hand
survives every deploy. A second run writes none; on an empty database it reads nothing.
`0066-membership-registered-by` (Phase 19.17, P19.17-T1; ADR-0267 §3) prints `{ fromInvite, fromLeader, none }`: every
membership without `registeredByMembershipId`, any office and status, given who registered them — the sender of the
accepted invitation that made it (`memberInvites.invitedByMembershipId`), else the leader it was placed under
(`recruitedByMembershipId`), else `null` (an Owner, a roster row, a pending person). Only rows without the field; a
second run writes none.
`0067-success-rates-without-follow-ups` (Phase 19.17, P19.17-T1; ADR-0267 §6; the owner's part D) prints `{ ratios,
kept, snapshots, templates }`: every office's `SELLING_SUCCESS_RATE` and `RECRUITMENT_SUCCESS_RATE` (`origin: 'platform'`,
archived too, not soft-deleted) whose formula **and** recorded standard are still the ones with follow-ups, given the new
formula and standard together — *Submission polis ÷ Presentasi penjualan*, *Proses NPA ÷ Presentasi rekrut* — then those
on an Owner's own formula, kept; each office's newest published snapshot and every `ratio_set` company template moved
element by element by the same rule. Sides compared as sets, by code; no version moves. A second run moves none, and an
Owner who puts follow-ups back later is left alone (their standard is the new one).
`0068-informal-groups-on-abs` (Phase 19.17, P19.17-T4; ADR-0270 §1, §2) prints `{ leadersCarried, leadersDropped,
noLeader, absNarrowed, othersUntagged }`: every membership carrying tags, any office and status — **an AB keeps one live
group** (the one they were ★ of, else the first of their live groups by name, then id), **an AAB or an agent keeps
none** (they follow their AB), what was removed kept as `migrated0068.groupIds`; then every group without
`leaderMembershipIds` given the list — **its ★ as its one Group Leader while an active AB who now reads in it**, anybody
else dropped — `ownerMembershipId` removed and kept as `migrated0068.ownerMembershipId`. One `member.tagged` and one
`group.updated` audit row per change, named to the job, in the office's own log: what was dropped is there. A second run
writes none. **It has a `down`** (call it by hand) that puts every ★ and tag back from `migrated0068`.
`0069-ab-group-targets-by-month` (Phase 19.17, P19.17-T4; ADR-0270 §4; OD-387) prints `{ carried, months, kept,
droppedAab, droppedGone }`: every live `analyticsTargets` row of kind `subgroup` with a year whose leader is **an active
AB** carried into `abGroupTargets`, one row per month of that year — Active Agent as it was (it was already monthly),
Rekrut **spread** so the twelve add up to the year's (`spreadOverYear`; 6 a year reads 0, 1, 0, 1 …), `source:
'migration-0069'`; a month that already had a row kept (`$setOnInsert`); an AAB's row dropped (no AB group of their own)
and so is a leaver's or a non-leader's — both counted. **The `analyticsTargets` rows are left in place**, unread, and
`kpmRecruitTargets` is not touched. A second run writes none; with no `subgroup` row it reads nothing and creates no
collection. **It has a `down`** (call it by hand) that removes the rows it wrote and nobody has saved over since.
`0076-forum-one-agenda-and-carried-items` (Phase 19.22, P19.22-T8; ADR-0276; OD-418) prints `{ forums, picsMatched,
picsDropped, picsAll }`: every `leaderMeetings` row without `agendaItems` reshaped — *Preparation*, *During* and *Post*
**one checklist in that order** (text, box, id and version kept), the rows the new action items (*Action item* the text,
else the *Key initiative*, else the *Success metric*; *Not yet planned · Planned · Implemented* → `todo · doing · done`;
no *tenggat*; **its own lineage**, `fromNumber: null`), each typed PIC **matched to one active member of the office** by
full, preferred or unique first name — *Semua* / *All* read as *Semua* on an agenda line — and anything else no PIC;
`time: null`. The old agenda and rows are kept as `legacyMinutes`, read by nothing. One `leader_meeting.reshaped` audit
row per forum, named to the job. A second run writes none; with no `leaderMeetings` collection it reads nothing and
creates none. **It has a `down`** (call it by hand) that puts the old agenda and rows back from `legacyMinutes`.
