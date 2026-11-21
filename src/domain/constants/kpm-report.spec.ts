import { CONSOLE, KPM_REPORT } from '@/domain/constants';

describe('KPM_REPORT — the KPM report’s numbers (ADR-0280; metrics §B.46)', () => {
  it('P19.24-T2 AC-1 makes a report for the KPM’s month and the twelve before it', () => {
    expect(KPM_REPORT.MONTHS_BACK).toBe(12);
  });

  it('P19.24-T1 AC-2 sets no text smaller than 12 CSS px, which is 9 pt', () => {
    expect(KPM_REPORT.MIN_TEXT_PT).toBe(9);
    expect((KPM_REPORT.MIN_TEXT_PT / 72) * 96).toBe(12);
  });

  it('P19.24-T1 AC-2 colours on the console’s one scale, never a scale of its own', () => {
    expect(CONSOLE.SCALE).toEqual({ GREEN_FROM_PCT: 80, YELLOW_FROM_PCT: 50 });
    expect(Object.keys(KPM_REPORT).some((k) => /GREEN|YELLOW|RED/.test(k))).toBe(false);
  });

  it('P19.24-T1 pins the tables’ chunks, the many-problems line and the top groups per action', () => {
    expect(KPM_REPORT.ACTION_COLUMNS_PER_TABLE).toBe(6);
    expect(KPM_REPORT.EVENT_COLUMNS_PER_TABLE).toBe(5);
    expect(KPM_REPORT.QUAL_MANY_ISSUES).toBe(7);
    expect(KPM_REPORT.TOP_GROUPS_PER_ACTION).toBe(2);
  });

  it('P19.24-T2 AC-1 a Kirim ke owner link opens for seven days, thirty opens an hour per account', () => {
    expect(KPM_REPORT.LINK_TTL_DAYS).toBe(7);
    expect(KPM_REPORT.LINK_OPENS_PER_HOUR).toBe(30);
  });

  it('P19.24-T1 AC-3 builds at most two reports at once in one process', () => {
    expect(KPM_REPORT.CONCURRENCY).toBe(2);
  });
});
