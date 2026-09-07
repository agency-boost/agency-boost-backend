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
    // **These three are floors at what is achieved, not at what the rule asks.** The rule
    // says 95% branch; `modules/org` is at 79. Setting 95 today would make the build red
    // on every commit, which is a broken build rather than a ratchet — so the number here
    // is the one no change may lower, and closing the remaining sixteen points is
    // **P4-T12** in the roadmap, with the gap named rather than hidden.
    //
    // Raise these as coverage improves. Never lower one to make a change pass.
    './src/modules/org/': { lines: 95, branches: 79, functions: 95, statements: 95 },
    './src/modules/tenants/': { lines: 95, branches: 85, functions: 93, statements: 95 },
    './src/modules/auth/': { lines: 95, branches: 84, functions: 89, statements: 95 },
  },
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
};

export default config;
