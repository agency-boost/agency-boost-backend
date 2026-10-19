// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // Time is injected. `new Date()` in production code is untestable and reads the
      // server's clock rather than the tenant's — the defect the prototype shipped
      // (prototype-parity F-01). See .claude/rules/domain-invariants.md §9.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Do not call new Date() directly — inject Clock and use clock.now() so day ' +
            'boundaries resolve in the tenant timezone and tests can control time.',
        },
      ],
    },
  },
  {
    // Tests construct dates on purpose — pinning behaviour to a known instant is the
    // point. The rule targets production code, where reading the ambient clock
    // silently couples a result to whatever timezone the server happens to run in.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
