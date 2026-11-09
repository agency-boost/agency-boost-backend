import { proposalsMade } from './proposals-made';

/** **P19.7-T2 AC-13 — `PROPOSALS_MADE`** (§A.16): first saves inside the window, on the KPM's calendar. */
describe('P19.7-T2 PROPOSALS_MADE (§A.16)', () => {
  const window = { from: '2026-11-01', to: '2026-11-05' };

  it('P19.7-T2 AC-13 counts each first save whose day in the office’s zone is in the window, both ends included', () => {
    expect(proposalsMade([
      new Date('2026-10-31T17:00:00Z'), // 00:00 WIB on 1 November: in
      new Date('2026-11-05T16:59:59Z'), // 23:59:59 WIB on 5 November: in
      new Date('2026-11-03T03:00:00Z'),
    ], window, 'Asia/Jakarta')).toBe(3);
  });

  it('P19.7-T2 AC-13 leaves out a first save the day before or after, read in Jakarta and not in UTC', () => {
    expect(proposalsMade([
      new Date('2026-10-31T16:59:59Z'), // 23:59:59 WIB on 31 October
      new Date('2026-11-05T17:00:00Z'), // 00:00 WIB on 6 November
    ], window, 'Asia/Jakarta')).toBe(0);
  });

  it('P19.7-T2 AC-13 never counts a draft: no first save, no count', () => {
    expect(proposalsMade([null, null], window, 'Asia/Jakarta')).toBe(0);
  });
});
