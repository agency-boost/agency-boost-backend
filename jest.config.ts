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
  },
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
};

export default config;
