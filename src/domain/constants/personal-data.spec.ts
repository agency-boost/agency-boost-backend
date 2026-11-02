import { AGENT_CODE_PATTERN, GENDERS, PERSONAL_DATA, WORK_STATUSES } from './index';

/**
 * What a person records (ADR-0158), pinned so a change to one fails here before it reaches the import,
 * registration or `/profile`. Each is documented once in `docs/00-product/metrics-and-definitions.md`.
 */
describe('the personal data constants (ADR-0158)', () => {
  it('takes a person at 18 or older', () => {
    expect(PERSONAL_DATA.MIN_AGE_YEARS).toBe(18);
  });

  it('records two genders and two ways of working, by code', () => {
    expect([...GENDERS]).toEqual(['male', 'female']);
    expect([...WORK_STATUSES]).toEqual(['full_time', 'part_time']);
  });

  it('takes an agent code of 3 to 32 digits and nothing else', () => {
    for (const ok of ['880', '88001', '1'.repeat(32), '000123']) expect(AGENT_CODE_PATTERN.test(ok)).toBe(true);
    for (const no of ['88', '1'.repeat(33), 'PRU-88001', '88 001', '88.001', ' 88001', '', '８８００１']) {
      expect(AGENT_CODE_PATTERN.test(no)).toBe(false);
    }
  });
});
