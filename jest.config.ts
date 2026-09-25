import type { Config } from 'jest';

// Coverage thresholds are the ratchet from docs/03-engineering/testing-strategy.md.
// They only move up. A change that lowers one fails CI, and the threshold is not
// edited to make a change pass.
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '\\.spec\\.ts$',
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
    './src/modules/campaigns/': { lines: 95, branches: 89, functions: 95, statements: 95 },
    './src/modules/events/': { lines: 95, branches: 83, functions: 95, statements: 95 },
    './src/modules/products/': { lines: 95, branches: 84, functions: 95, statements: 95 },
    // Statements sit just under 95 on `training-content.ts`, which is the one file here whose
    // gap is neither a rule nor a fallback: it is the Cloudinary-backed upload paths, and an
    // adapter that is stubbed in every test reports its error handling as unreached.
    './src/modules/training/': { lines: 95, branches: 83, functions: 91, statements: 94 },
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
   */
  maxWorkers: 4,
};

export default config;
