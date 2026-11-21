import { isTestAccount, isTestAccountName, TEST_ACCOUNT } from './test-accounts';

/**
 * **Test accounts are known by a stored flag; migration 0065 decides the old ones by two name prefixes** (P19.17-T1 AC-1;
 * ADR-0267 §1; OD-370 by its default).
 */
describe('test accounts (P19.17-T1 AC-1, ADR-0267 §1)', () => {
  it('pins the two prefixes the client named, and nothing else', () => {
    expect(TEST_ACCOUNT.NAME_PREFIXES).toEqual(['FMT', 'TES IMPOR']);
  });

  it.each([
    ['FMT Budi', true],
    ['fmt budi santoso', true],
    ['  FMT   Budi  ', true],
    ['FMT', true],
    ['TES IMPOR 3', true],
    ['tes  impor satu', true],
    ['TES IMPOR', true],
  ])('flags %j by its name', (name, flagged) => {
    expect(isTestAccountName(name)).toBe(flagged);
  });

  it.each([
    // A whole word: a name that only begins with the letters is a person.
    'FMTX Budi', 'Fmtadi', 'TES IMPORT', 'Tesimpor', 'Budi FMT',
    // The `.test` email and a one-word name are never the rule (every demo login, and maybe a real person).
    'Hilmy', 'owner@kpm0417.test', '', '   ',
  ])('does not flag %j', (name) => {
    expect(isTestAccountName(name)).toBe(false);
  });

  it('reads no name it was not given', () => {
    expect(isTestAccountName(null)).toBe(false);
    expect(isTestAccountName(undefined)).toBe(false);
  });

  it('is one predicate over the stored flag: only true is a test account, a row without it is a person', () => {
    expect(isTestAccount({ testAccount: true })).toBe(true);
    expect(isTestAccount({ testAccount: false })).toBe(false);
    expect(isTestAccount({ testAccount: null })).toBe(false);
    expect(isTestAccount({})).toBe(false);
    expect(isTestAccount(null)).toBe(false);
    expect(isTestAccount(undefined)).toBe(false);
  });
});
