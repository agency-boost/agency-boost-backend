import { availableParallelism } from 'node:os';
import type { Config } from 'jest';

// Coverage thresholds are the ratchet from docs/03-engineering/testing-strategy.md.
// They only move up. A change that lowers one fails CI, and the threshold is not
// edited to make a change pass.
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '\\.spec\\.ts$',
  // P18.4-T2: `*.live.spec.ts` reaches a real bucket and runs only under `pnpm test:storage-live`, which
  // replaces this list. Every other script — the full run, coverage, integration, tenancy — leaves it out.
  //
  // `*.performance.spec.ts` runs only under `pnpm test:performance`, one suite at a time, which replaces this
  // list too. A p95 taken beside three other workers measures the other workers, and one taken under coverage
  // measures the instrumentation. The forum's meeting read, ≈ 710 ms alone on a laptop, took 10.5 s in the CI
  // runner's unit run and 48 s under its coverage run, and starved the tenancy suites into hook timeouts
  // beside it (the first run on GitHub, 2026-10-23).
  testPathIgnorePatterns: ['/node_modules/', '\\.live\\.spec\\.ts$', '\\.performance\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    // Entry points, not application code: nothing imports them, and their correctness is
    // established by running them rather than by asserting on branches. `main.ts` was
    // always excluded on this basis; the seed is excluded for the same reason and no
    // other — it is a fixture builder run by hand, and it is exercised end to end every
    // time the demo tenant is rebuilt.
    //
    // Excluding code is how a ratchet gets gamed, so the list stays short and each entry
    // carries its reason. Nothing that serves a request belongs here.
    '!src/main.ts',
    // The Swagger builder `main.ts` and `pnpm openapi` both call. It constructs a
    // description object and returns it; there is no branch to get wrong, and its output
    // is checked where it matters — `openapi.json` is regenerated and reviewed in the
    // diff, and `check-api-consumers.py` walks the same controllers independently.
    '!src/openapi.ts',
    '!src/**/*.module.ts',
    '!src/seed/**',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { lines: 80, branches: 80, functions: 80, statements: 80 },
    // Tenancy and permissions carry the whole weight of isolation — MongoDB has no
    // row-level security backstop (ADR-0002), so these are 100% branch.
    //
    // This comment said "and permissions" from the day it was written, while the list
    // below held tenancy alone. `src/modules/rbac/` — the grant list and the scope
    // resolution every guard calls — ran under the global 80% until 2026-09-06, and
    // `src/common/auth/` with it: the guards that decide whether a request is anybody at
    // all. Both were near enough already that pinning them cost two test files.
    './src/common/tenancy/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/rbac/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // P11-T3: `COACH(actor, subject)` and the subject reads that go through it. It decides who may
    // read whose data, so it is permissions code held to the permissions floor, although it lives in
    // `modules/org` beside the tree — whose own floor is lower, and says why.
    './src/modules/org/coach-resolver.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // P18.9-T8 L2 (the Phase 18.9 exit permission review): which memberships a reader may see — the roster, one
    // member's read, their reports, the *Rejoined* mark, the tree and a removal's destination all narrow through it —
    // and who administers the office, the Owner's grant and revoke. Permissions code, held where the resolver is
    // although `modules/org` around them is not. `reader-visibility.ts` was `visibleTo` and its compositions inside
    // `directory.service.ts`, whose own floor is the module's; `admin-delegation.service.ts` stood at 77% branch,
    // its gaps an admin nobody granted (now tested) and two arms no input reaches (removed).
    './src/modules/org/reader-visibility.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/org/admin-delegation.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // P11-T3: the §3.5 seam every coach read of a coachee's data calls — who read whose data, and
    // the self-read it skips. It decides what the record of disclosures holds, so it is held where
    // the resolver is, although `modules/audit` around it runs under the global floor.
    './src/modules/audit/subject-read-audit.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/common/auth/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/common/context/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * **`common/time` is invariant §9 made executable**, so it is pinned with the isolation code
     * rather than with the modules. A day boundary computed in the server's clock is a bug; the
     * prototype computes every one of them that way, and this is the file that does not. It is at
     * 100 today and a branch that stops being covered here is a day somebody files against the
     * wrong date.
     */
    './src/common/time/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // **`common/format` is how every sentence the API composes writes a date, a sum or a percentage** (ADR-0167 §1),
    // and it places an instant on the tenant's clock as `common/time` does: pinned with it, for the same reason.
    './src/common/format/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Business rules and constants: a silently wrong number is worse than a crash.
    //
    // `./src/domain/` alone used to stand for "business-rule modules", and it is sixteen
    // lines of constants. The rule in `docs-and-tests-required.md` says ≥95% for domain
    // **and business-rule** modules, and the modules that carry the rules — removal,
    // role change, approvals, the hierarchy — sat at 78% branch under the global floor,
    // unpinned. The ratchet passed because it was not configured to ask.
    //
    // The exit re-review found two authorization defects in exactly the files with the
    // widest branch gaps. These are the numbers the rule states; where a module is short,
    // the threshold is the debt made visible rather than the debt hidden.
    './src/domain/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    //
    // **These four are floors at what is achieved, not at what the rule asks**, and
    // `P4-T12` raised three of them: `auth` 84 → 86, `tenants` 87 → 89, `config` to 87.
    // `password.service.ts` went from **20% branch to 100%** — a credential-handling
    // module deciding whether somebody gets in, and its most important branch untested:
    // `verify` swallowing a malformed stored hash so a corrupted row reads as a wrong
    // password rather than telling an attacker this account is different.
    //
    // **`modules/org` is the one that barely moved, and the reason is worth recording.**
    // Five tests of its genuinely load-bearing fallbacks — a group owner whose account was
    // erased, a tag on an archived group — moved it 79.3 → 80.1. What remains is roughly
    // fifty `?? 'Unknown'`, `?? 0` and `?.` fallbacks on rows that have gone, spread
    // across eight services. Branch coverage counts each as a branch, so a module full of
    // defensive reads across a graph scores low even when every *decision* is tested.
    //
    // Closing it to 95 means fifty fixtures that delete one referenced row each to assert
    // a fallback string is that string. That is coverage theatre, and it is the shape of
    // test this project's own conventions argue against. **The decision belongs to the
    // exit review**, and OD-46 states it: accept a lower floor for this module with the
    // reason, or measure something other than branch percentage here.
    //
    // Raise these as coverage improves. Never lower one to make a change pass.
    './src/modules/org/': { lines: 95, branches: 80, functions: 95, statements: 95 },
    './src/modules/tenants/': { lines: 95, branches: 89, functions: 92, statements: 95 },
    './src/modules/auth/': { lines: 95, branches: 86, functions: 94, statements: 95 },
    './src/modules/config/': { lines: 95, branches: 87, functions: 83, statements: 95 },
    //
    // **The six modules Phase 5 shipped, absent from this list until the phase exit review.**
    //
    // They rode the global 80% — which Jest checks as one whole-project aggregate, not per
    // module — so each was diluted into a much larger, well-tested codebase and none was ever
    // asked a question about itself. Three did not clear 80% on their own. `capability` sat at
    // 66% branch while the ratchet reported green, which is the same failure the `./src/domain/`
    // note above records: the gate passed because it was not configured to ask.
    //
    // **What the numbers were made of mattered more than the numbers.** Before pinning anything,
    // every gap was read. Most of `capability`, `campaigns` and `events` turned out to be
    // *untested rules* rather than untested fallbacks — a payload part that is not a list, a
    // stage nobody can be on, a campaign window that ends before it starts, two events sharing a
    // code. Each stops a record that otherwise publishes silently and breaks an office later, and
    // each is now covered. `CapabilityService.seedForOffice` went the other way: no caller
    // anywhere, so it was deleted rather than tested.
    //
    // What is left is the shape `modules/org` describes above — `?? {}`, `?? 0`, and
    // `x !== undefined ? { x } : {}` spreads, which branch coverage counts one apiece. Closing
    // those means a fixture per fallback asserting a default is the default, and that is the
    // coverage theatre this project's conventions argue against.
    //
    // So: 95 where a module meets it, and the achieved figure where it does not — the same rule
    // the four entries above follow, and the same bargain. The threshold is the debt made
    // visible, not the debt hidden.
    './src/modules/activation/': { lines: 95, branches: 90, functions: 95, statements: 95 },
    // Phase 18.2 (the permission review, item 18): the agent's campaigns brought the module to the domain floor, and
    // the two files that decide what a member sees of a chase are pinned whole.
    './src/modules/campaigns/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    './src/modules/campaigns/campaign-agent.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/campaigns/campaign-chase-readings.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Phase 18.3 (P18.3-T2): the override of a final standing and the port the compliance tree reads, pinned whole.
    './src/modules/campaigns/campaign-standing-overrides.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/campaigns/campaign-standings-reader.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Phase 18.3 (P18.3-T2): the compliance tree's Events and Campaigns categories, 100 / 100 / 100 / 100 over their own specs.
    './src/modules/reporting/compliance/events.category.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/reporting/compliance/campaigns.category.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Phase 18.2 (the exit review, 14): the members' events brought the module to the domain floor — 99.1 / 95.9 / 100
    // / 99.1 over its own specs alone — and the four files that decide who an event is for, what a member writes, and
    // what the Owner reads and confirms are pinned whole.
    './src/modules/events/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    './src/modules/events/event-audience.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/events/event-guest.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Phase 18.11 (the exit review, T1): the coachee's tick from Calendar — who may write it, a tick that changes nothing,
    // and the session gone between the read and the write — pinned whole by its own spec.
    './src/modules/coaching/coaching-action-done.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/events/event-roll-call.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/events/event-readings.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/products/': { lines: 95, branches: 84, functions: 95, statements: 95 },
    // Raised at Phase 18.2 (training progress, a business-rule module now; the exit review's B3): `training-content.ts`,
    // the gap this note used to explain, has its own spec, and the module measured 99.6 / 96.0 / 97.6 / 99.2 over its
    // own and activation's specs. The two files that decide what a learner is offered and who may set or read a status
    // — what is offered, and the progress service — are pinned whole.
    './src/modules/training/': { lines: 98, branches: 95, functions: 97, statements: 98 },
    './src/modules/training/offered-training.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/training/training-progress.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // The lowest floor in this file, and named rather than rounded up to look better: what
    // remains in `capability` is `capability-payload.ts`'s and `capability.service.ts`'s
    // defensive reads — a null payload, a row with no `code` key, a catalog belonging to an
    // office provisioned before the feature existed. Every rule the module enforces is covered.
    './src/modules/capability/': { lines: 95, branches: 73, functions: 95, statements: 95 },
    /*
     * P6, raised 78 → 80 at the phase exit review.
     *
     * What is left is two guards that are **unreachable today** — a context carrying an office
     * without a membership — plus the defensive reads on the office's settings (`?? ACTIVITY.…`
     * for an office provisioned before a knob existed) and the view's `?? 0` for a day with no
     * row. Every rule is covered: the window, the freeze, the clamp, the scope, rung
     * applicability, every named period, and the day boundary (which lives in `common/time`,
     * pinned at 100).
     */
    './src/modules/activity/': { lines: 95, branches: 80, functions: 95, statements: 95 },
    /*
     * P7-T1. The record about somebody who is not a user of this product, so the rule that has to
     * be covered is the one about holding their details at all: the ground before the phone
     * number, in both directions — adding details with no ground, and withdrawing the ground from
     * a lead that still holds them.
     *
     * What is left uncovered is the `partial` branch of a required field, which the create path
     * always takes one way and the patch path always the other. Raised as the module grows.
     */
    './src/modules/leads/': { lines: 95, branches: 88, functions: 95, statements: 95 },
    // P8: the goal record and the cascade that reads it. A ratchet, not a target — the
    // module is at 100/94 on the day it lands, and these are the numbers it may not fall
    // below.
    './src/modules/goals/': { lines: 95, branches: 90, functions: 95, statements: 95 },
    // P9: the authoritative APE source. Every downstream figure reads it, so the floor is the
    // domain one from the first task rather than something to ratchet towards.
    './src/modules/production/': { lines: 95, branches: 90, functions: 95, statements: 95 },
    // P10-T4: the Personal Summary is arithmetic over three modules' readings — every branch is a
    // figure somebody reads as their standing, so it carries the domain floor whole.
    './src/modules/summary/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    // P11-T5, P11-T6: coaching — the sessions, the metrics read over them and the roster's verdicts.
    // Business rules from the first task, so the domain floor from the first day, as production's was.
    './src/modules/coaching/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    // Phase 12: the calendar — who reads whose entry, the office's week and month, and the notices. Rules
    // from the first task (the read's projection, the version pin, the busy block), so the domain floor
    // from the first day, as coaching's was.
    './src/modules/calendar/': { lines: 95, branches: 95, functions: 95, statements: 95 },
    // N5, the Phase 12 exit permission review: the three calendar files that decide who reads and writes
    // whose entry are permissions code, held to the floor `coach-resolver.ts` is. `calendar-view.ts` is the
    // projection a reader is answered (an entry in full, or a busy block with nothing of it); the service
    // decides reach, the organiser-only write, who must be invitable and what each write records; the
    // repository pins every write to its office, organiser and version. All three were at 100 when pinned.
    './src/modules/calendar/calendar-view.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/calendar/calendar.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/calendar/calendar-event.repository.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * Phase 15: the Unit Dashboard — who reads which unit, every row's figures and the totals, and a leader's
     * corrections. Business rules, so the domain floor at least (raised from 90 at the exit review, S3): its
     * defensive reads — a rung the ladder does not name, a membership nobody can name, an office with no
     * company — each have a test, and the reach it reads is `CoachResolver.unitOf`'s, pinned at 100 there.
     */
    './src/modules/unit-dashboard/': { lines: 98, branches: 95, functions: 95, statements: 98 },
    /*
     * Phase 17: recruitment tools — the plan from a company's playbook, the playbook's save, and an office's four
     * pitch documents. Business rules from the first task (the plan's one function, the completion rule, the
     * replace that clears the ticks), so the domain floor at least; the module stood at 100 on every measure the
     * day it landed. The four files that decide **whose** words and **whose** documents a reader reaches are
     * isolation code, held where `calendar`'s three are: the plan's read (its office's own company, never one a
     * caller names); the playbook's service (the named company-filtered read every plan goes through, and the
     * console's write to the company in its address, pinned to its version — the exit review's S1); and the
     * pitch's service and its tenant-scoped repository (an office's own four, 404 outside them).
     */
    './src/modules/recruitment/': { lines: 98, branches: 95, functions: 95, statements: 98 },
    './src/modules/recruitment/recruitment-plan.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/recruitment/recruitment-playbook.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/recruitment/recruitment-pitch.service.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/recruitment/recruitment-pitch.repository.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * Phase 18: the Owner's reporting — the Overview, the analytics, the platform's adoption and the directory's two
     * columns. Arithmetic over other modules' readings, every branch a figure an Owner reads as their office's, so the
     * domain floor at least from the day it lands. The two files that decide **who is counted where** are held at
     * 100: the agency partition (D-units — which row a member is in, so a total is the sum of its rows) and the one
     * headcount every denominator reads (OD-24, OD-74 — who is a member on a day).
     */
    './src/modules/reporting/': { lines: 98, branches: 95, functions: 95, statements: 98 },
    './src/modules/reporting/agency-partition.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/domain/metrics/office-headcount.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Tenancy-bearing: the target's one atomic write and its carry-forward, and the membership repository that holds
    // the two named `…AcrossTenants` reads the platform's adoption makes (invariant §1: tenancy at 100% branch).
    './src/modules/reporting/kpm-recruit-target.repository.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/org/membership.repository.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * Phase 18.3: the Owner's compliance tree — who is listed where, every category's status and chip, and what a read
     * discloses. Business rules over other modules' readers, so the reporting floor (P18.3-T1 asks ≥95% branch); it
     * measured 100 on every figure the day it landed. Activation's bulk reader answers every hire's activation of an
     * office in one read — what the tree discloses of them — so it is held whole, as the partition is.
     */
    './src/modules/reporting/compliance/': { lines: 98, branches: 95, functions: 95, statements: 98 },
    './src/modules/activation/activation-readings.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Phase 18.1: who reads the forum and who edits it — the tag is the list, and a field member not tagged meets 404.
    // It decides access, so it is held where the permissions are.
    './src/modules/leader-meetings/leader-meeting-people.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * Phase 18.4 (P18.4-T2, ADR-0153): storage. The adapter decides what an upload may be and what a file is
     * confirmed as, and the sniff is the one check standing where Cloudinary read the bytes itself (ADR-0040), so
     * both are held whole; so is the choice between the bucket and the storage that refuses. All four measured
     * 100 on every figure the day they landed.
     */
    './src/modules/assets/gcs.adapter.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/assets/content-sniff.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/assets/unconfigured-storage.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    './src/modules/assets/storage.provider.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * Phase 18.11 T18 (ADR-0182): which provider sends the mail, and with what. Boot validation, the adapter and the
     * test command all decide from it, so a branch wrong here is mail that silently stops, or a password sent before
     * TLS; held whole, as the storage choice is. It measured 100 on every figure the day it landed.
     */
    './src/modules/notifications/mail-provider.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
    /*
     * ADR-0184: the workbook reader and writer, the ZIP guard in front of them, and the upload interceptor both imports
     * receive a file through. A branch wrong in the guard is a zip bomb unpacked; held whole, as the asset sniff is. It
     * measured 100 on every figure the day it landed.
     */
    './src/common/spreadsheet/': { lines: 100, branches: 100, functions: 100, statements: 100 },
  },
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  /*
   * **The one shared `mongod` has a concurrency ceiling, and Jest's default walks past it.**
   *
   * `test/global-setup.ts` starts a single in-memory server for the whole run — itself a fix for
   * a dozen `mongod` processes racing to start and blowing the library's 10s budget. What it
   * trades away is headroom: every worker connects to the same server, and past a certain number
   * of them `mongoose.connect()` simply stops answering. The three heaviest suites then die on a
   * 30s hook timeout, taking ~325 tests with them, while passing perfectly when run alone.
   *
   * Measured on a 12-core machine when the Phase 5 controller specs took the suite from 95 files
   * to 99: 11 workers (the default here) fails, 8 fails, 6 passes twice, 4 passes and is the
   * *fastest* run of the four. A fixed 4 rather than a percentage, because the limit belongs to
   * the database server, not to the number of cores — a 32-core runner would scale a percentage
   * straight back over the edge.
   *
   * **What the ceiling was, found 2026-09-29.** Not connections: table churn. Every suite built a
   * database from nothing and dropped it, and WiredTiger's schema lock serialised the workers'
   * index builds behind the drops — a 42 s `syncIndexes`, one full run in three failed. A database
   * per worker, wiped rather than dropped (`test/mongo.ts`), ended it; `TEST_DB_TRACE=1` shows any
   * slow operation on the shared server if it comes back.
   *
   * **And never more workers than cores** (2026-11-06). GitHub's runner for this private repository has two vCPUs
   * and 7 GB. Four workers there, beside `mongod` and the PDF and image specs, starved each other: suites ran four to
   * ten times their local time, 30 s hooks timed out, and one run lost its runner (*"starves it for CPU/Memory"*). The
   * database's ceiling stays 4; the machine's is its cores.
   */
  maxWorkers: Math.min(4, availableParallelism()),
  /*
   * **A worker that has grown past 1 GB is replaced after its suite** (2026-11-06): each integration suite boots a
   * Nest application, and what a few hundred of them leave behind in one worker reached the runner's heap limit late
   * in the run, where every hook slowed to a timeout. Jest restarts it between suites; nothing inside a suite changes.
   */
  workerIdleMemoryLimit: '1GB',
};

export default config;
