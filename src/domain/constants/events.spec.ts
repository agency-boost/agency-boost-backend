import {
  EVENT_ATTENDANCE_STATUSES, EVENT_AUDIENCE_SCOPES, EVENT_FEEDBACK_TEXT_MAX, EVENT_ISSUERS, EVENT_PHASES, NPS,
  SELECT_AUDIENCE_SCOPES,
} from './events';

/** Every value the events' rules read, pinned once (invariant §7; `metrics-and-definitions.md` §B). */
describe('the events’ constants (Phase 5, Phase 18.5)', () => {
  it('P5-T6 the issuers, the four audiences and the two that carry a list; the phase is derived, three values', () => {
    expect(EVENT_ISSUERS).toEqual(['company', 'kpm', 'group']);
    expect(EVENT_AUDIENCE_SCOPES).toEqual(['all_agents', 'select_agents', 'leaders', 'select_leaders']);
    expect(SELECT_AUDIENCE_SCOPES).toEqual(['select_agents', 'select_leaders']);
    expect(EVENT_PHASES).toEqual(['upcoming', 'running', 'past']);
  });

  it('P18.5-T5 AC-8 the attendance statuses, `unconfirmed` among them (D-status)', () => {
    expect(EVENT_ATTENDANCE_STATUSES).toEqual(['attended', 'registered', 'unconfirmed', 'no_show', 'not_registered']);
  });

  it('P18.5-T6 AC-3 the NPS scale and its buckets (`KPM_Owner.html:3754-3761`), and the answers’ length', () => {
    expect(NPS).toEqual({ SCALE_MIN: 0, SCALE_MAX: 10, PROMOTER_MIN: 9, DETRACTOR_MAX: 6 });
    expect(EVENT_FEEDBACK_TEXT_MAX).toBe(1000);
  });
});
