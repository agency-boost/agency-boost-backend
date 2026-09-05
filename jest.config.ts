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
    '!src/**/*.module.ts',
    '!src/seed/**',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { lines: 80, branches: 80, functions: 80, statements: 80 },
    // Tenancy and permissions carry the whole weight of isolation — MongoDB has no
    // row-level security backstop (ADR-0002), so these are 100% branch.
    './src/common/tenancy/': { lines: 100, branches: 100, functions: 100, statements: 100 },
    // Business rules and constants: a silently wrong number is worse than a crash.
    './src/domain/': { lines: 95, branches: 95, functions: 95, statements: 95 },
  },
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};

export default config;
