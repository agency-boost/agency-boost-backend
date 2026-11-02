import {
  LEADER_MEETING_LIMITS, LEADER_MEETING_SHARE_DAYS, LEADER_MEETING_SHARE_TOKEN_BYTES, LEADER_MEETING_TARGET_RATE_DECIMALS,
} from '@/domain/constants';

describe('the Strategic Leader Forum’s constants (Phase 18.1, §B)', () => {
  it('P18.1-T3 AC-1 a shared link opens for 14 days, the forum’s two-week cadence (ADR-0131 §3, `:2714`)', () => {
    expect(LEADER_MEETING_SHARE_DAYS).toBe(14);
  });

  it('P18.1-T3 AC-1 a link’s token is 32 random bytes (ADR-0131 §1)', () => {
    expect(LEADER_MEETING_SHARE_TOKEN_BYTES).toBe(32);
  });

  it('P18.1-T2 AC-7 the bounds of what the leaders type: a title 120, a text 500, a PIC 80, a target 40', () => {
    expect(LEADER_MEETING_LIMITS).toEqual({ titleMax: 120, textMax: 500, picMax: 80, targetMax: 40 });
    // The prototype's own longest values fit: a title, and a Monthly Target cell (`:2470`).
    expect('Strategic Check-in — #14'.length).toBeLessThanOrEqual(LEADER_MEETING_LIMITS.titleMax);
    expect('22 (3 @ unit)'.length).toBeLessThanOrEqual(LEADER_MEETING_LIMITS.targetMax);
  });

  it('P18.97-T1 AC-10 a Monthly Target’s rate is typed and kept to two places (ADR-0175 §4)', () => {
    expect(LEADER_MEETING_TARGET_RATE_DECIMALS).toBe(2);
  });
});
