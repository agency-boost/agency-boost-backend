import { EVENT_DECLINE_REASON_MAX, EVENT_FEEDBACK_BANDS, EVENT_KEHADIRAN } from '@/domain/constants';
import {
  eventNpsTone, feedbackFigure, isRecorded, kehadiranFigure, kehadiranMark, kehadiranTone, memberKehadiran,
  type KehadiranMark,
} from './event-kehadiran';

const marks = (s: string) => s.split('') as KehadiranMark[];

describe('P19.25 EVENT_KEHADIRAN — the constants are pinned (ADR-0281; metrics-and-definitions.md)', () => {
  it('P19.25-T1 AC-2 the bands, the window, the staleness and the WhatsApp line do not drift', () => {
    expect(EVENT_KEHADIRAN).toEqual({
      GREEN_FROM_PCT: 80, YELLOW_FROM_PCT: 50, RECENT_EVENTS: 15, STALE_AFTER_EVENTS: 3, WHATSAPP_UNDER_PCT: 50,
    });
  });
  it('P19.25-T2 AC-2 the NPS bands and sedikit jawaban do not drift; the decline reason is at most 200', () => {
    expect(EVENT_FEEDBACK_BANDS).toEqual({ GREEN_FROM: 30, YELLOW_FROM: 0, FEW_UNDER: 3 });
    expect(EVENT_DECLINE_REASON_MAX).toBe(200);
  });
});

describe('P19.25-T1 AC-2 kehadiranTone — green ≥ 80, yellow 50–79, red < 50', () => {
  it.each([[100, 'green'], [80, 'green'], [79, 'yellow'], [50, 'yellow'], [49, 'red'], [0, 'red']] as const)('%i%% is %s', (pct, tone) => {
    expect(kehadiranTone(pct)).toBe(tone);
  });
  it('no share, no colour', () => expect(kehadiranTone(null)).toBeNull());
});

describe('P19.25-T2 AC-2 eventNpsTone — green ≥ +30, yellow 0–29, red < 0', () => {
  it.each([[100, 'green'], [30, 'green'], [29, 'yellow'], [0, 'yellow'], [-1, 'red'], [-100, 'red']] as const)('%i is %s', (nps, tone) => {
    expect(eventNpsTone(nps)).toBe(tone);
  });
  it('no NPS, no colour', () => expect(eventNpsTone(null)).toBeNull());
});

describe('P19.25-T1 AC-2 kehadiranMark and isRecorded — hadir or tidak hadir, every member expected', () => {
  it('outside the audience is no mark; an unrecorded event is ?; attended is 1; everything else 0', () => {
    expect(kehadiranMark(false, true, null)).toBe('.');
    expect(kehadiranMark(true, false, 'unconfirmed')).toBe('?');
    expect(kehadiranMark(true, true, 'attended')).toBe('1');
    for (const status of ['no_show', 'unconfirmed', 'not_registered', 'registered'] as const) {
      expect([status, kehadiranMark(true, true, status)]).toEqual([status, '0']);
    }
  });
  it('an event is recorded once somebody was marked, attended or absent — a claim or an RSVP records nothing', () => {
    expect(isRecorded(['unconfirmed', 'not_registered'])).toBe(false);
    expect(isRecorded([])).toBe(false);
    expect(isRecorded(['not_registered', 'no_show'])).toBe(true);
    expect(isRecorded(['attended'])).toBe(true);
  });
});

describe('P19.25-T1 AC-2, AC-4 kehadiranFigure — averages per event, the share from the sums', () => {
  it('the mockup’s card: 266 hadir of 450 over 15 events is "rata-rata 18 dari 30", 59%, yellow', () => {
    const perEvent = [5, 24, 6, 14, 22, 18, 25, 11, 21, 9, 23, 24, 12, 22, 30].map((hadir) => ({ hadir, expected: 30 }));
    expect(perEvent.reduce((s, e) => s + e.hadir, 0)).toBe(266);
    expect(kehadiranFigure(perEvent, 0)).toEqual({ hadir: 18, expected: 30, pct: 59, tone: 'yellow', events: 15 });
  });
  it('a group over 15 events to one decimal: 107 of 150 is "7,1 dari 10 orang", 71%', () => {
    const perEvent = Array.from({ length: 15 }, (_, i) => ({ hadir: i < 2 ? 8 : 7, expected: 10 }));
    expect(kehadiranFigure(perEvent, 1)).toEqual({ hadir: 7.1, expected: 10, pct: 71, tone: 'yellow', events: 15 });
  });
  it('the share comes from the sums, never from the rounded averages; a half rounds up', () => {
    // 23 of 40 is 57.5% exactly: 58, where 23 / 40 * 100 reads 57.49999…
    expect(kehadiranFigure([{ hadir: 23, expected: 40 }], 0)).toMatchObject({ pct: 58, hadir: 23, expected: 40 });
    expect(kehadiranFigure([{ hadir: 8, expected: 10 }], 0)).toMatchObject({ pct: 80, tone: 'green' });
  });
  it('over no event, or nobody expected, every figure is null', () => {
    expect(kehadiranFigure([], 1)).toEqual({ hadir: null, expected: null, pct: null, tone: null, events: 0 });
    expect(kehadiranFigure([{ hadir: 0, expected: 0 }], 0)).toMatchObject({ pct: null, events: 1 });
  });
});

describe('P19.25-T1 AC-5 memberKehadiran — Per orang', () => {
  it('"Hadir 2 dari 12 event": every recorded event they were expected at; . and ? count for nothing', () => {
    const m = memberKehadiran(marks('1?00.000000.010'));
    expect(m).toMatchObject({ attended: 2, expected: 12, pct: 17, tone: 'red', underHalf: true });
  });
  it('Terakhir hadir is the newest attended; red when more than three expected events have passed since it', () => {
    expect(memberKehadiran(marks('0001'))).toMatchObject({ lastIndex: 3, since: 3, stale: false });
    expect(memberKehadiran(marks('00001'))).toMatchObject({ lastIndex: 4, since: 4, stale: true });
    // An event they were not expected at, or one not recorded, is not one they missed.
    expect(memberKehadiran(marks('0.?0001'))).toMatchObject({ lastIndex: 6, since: 4, stale: true });
    expect(memberKehadiran(marks('0..?001'))).toMatchObject({ since: 3, stale: false });
  });
  it('never attended: red once more than three events have passed; nobody expected is not red', () => {
    expect(memberKehadiran(marks('000'))).toMatchObject({ lastIndex: null, since: 3, stale: false });
    expect(memberKehadiran(marks('0000'))).toMatchObject({ lastIndex: null, since: 4, stale: true });
    expect(memberKehadiran(marks('..??'))).toMatchObject({ expected: 0, pct: null, stale: false, underHalf: false });
  });
  it('WhatsApp under half: 5 of 11 is 45%, offered; 1 of 2 is 50%, not', () => {
    expect(memberKehadiran(marks('11111000000'))).toMatchObject({ pct: 45, tone: 'red', underHalf: true });
    expect(memberKehadiran(marks('10'))).toMatchObject({ pct: 50, tone: 'yellow', underHalf: false });
  });
  it('the strip’s window is the last 15 recorded events — older ones still count in Hadir', () => {
    const m = memberKehadiran(marks(`${'1'.repeat(14)}?.${'1'.repeat(5)}`));
    // 14 + the "." are the newest 15 recorded; the "?" is not recorded.
    expect(m).toMatchObject({ recentAttended: 14, recentExpected: 14, attended: 19, expected: 19 });
  });
});

describe('P19.25-T2 AC-1, AC-2 feedbackFigure — EVENT_NPS, its average, its buckets, sedikit jawaban', () => {
  it('the September Town Hall: 25/50/25 of 8 is NPS 0, yellow', () => {
    const f = feedbackFigure([10, 9, 8, 8, 7, 7, 6, 3]);
    expect(f).toEqual({ nps: 0, average: 7.3, answers: 8, shares: { promoter: 25, passive: 50, detractor: 25 }, tone: 'yellow', few: false });
  });
  it('promoters 9–10, passives 7–8, detractors 0–6: NPS = % promoters − % detractors', () => {
    expect(feedbackFigure([9, 9, 9, 6])).toMatchObject({ nps: 50, tone: 'green' });
    expect(feedbackFigure([6, 6, 9])).toMatchObject({ nps: -33, tone: 'red', few: false });
  });
  it('under three answers is sedikit jawaban; none is null everywhere', () => {
    expect(feedbackFigure([8, 8])).toMatchObject({ few: true, answers: 2 });
    expect(feedbackFigure([])).toEqual({ nps: null, average: null, answers: 0, shares: null, tone: null, few: true });
  });
});
