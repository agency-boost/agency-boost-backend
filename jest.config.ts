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
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/**/*.module.ts'],
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
