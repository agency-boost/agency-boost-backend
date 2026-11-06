import { OfficeAudience, type AudiencePerson, type AudienceQuestion, type LeaderEdge } from './event-audience';
import { eventPhase, hasEnded, localTimeOf } from './event-phase';

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const person = (membershipId: string, over: Partial<AudiencePerson> = {}): AudiencePerson => ({
  membershipId, status: 'active', joinedAt: D('2026-01-01'), removedAt: null, leaderId: null, ...over,
});
const edge = (
  membershipId: string, toLeaderId: string | null, validFrom: string, order = validFrom, fromLeaderId: string | null = null,
): LeaderEdge => ({
  membershipId, fromLeaderId, toLeaderId, validFrom: D(validFrom), order,
});
const ask = (over: Partial<AudienceQuestion> = {}): AudienceQuestion => ({
  scope: 'all_agents', inviteeMembershipIds: [], startsAt: D('2026-08-10'), upcoming: false, ...over,
});

/**
 * **The audience as at the start** (P18.2-T5 AC-3; ADR-0039, ADR-0135, invariant §5), as a pure rule.
 * `event-guest.int.spec.ts` walks it through the routes over the coaching office.
 */
describe('an event’s audience, as at its start (P18.2-T5 AC-3)', () => {
  it('P18.2-T5 AC-3 all agents: everybody who was a member then — not the latecomer, not the pending, the leaver until they left', () => {
    const audience = new OfficeAudience([
      person('here'),
      person('late', { joinedAt: D('2026-09-01') }),
      person('pending', { status: 'pending' as never, joinedAt: null }),
      person('left-after', { status: 'removed', removedAt: D('2026-08-20') }),
      person('left-before', { status: 'removed', removedAt: D('2026-08-01') }),
      person('old-row', { joinedAt: null }),
    ], []);
    expect(audience.audienceOf(ask())).toEqual(['here', 'left-after', 'old-row']);
  });

  it('P18.2-T5 AC-3 an upcoming event reads the office as it is now: the active members', () => {
    const audience = new OfficeAudience([
      person('here'), person('late', { joinedAt: D('2026-09-01') }), person('left', { status: 'removed', removedAt: D('2026-08-20') }),
    ], []);
    expect(audience.audienceOf(ask({ upcoming: true, startsAt: D('2026-10-01') }))).toEqual(['here', 'late']);
  });

  it('P18.2-T5 AC-3 leaders: those leading somebody present, by the edges valid then — never the rung', () => {
    const people = [
      person('ab'), person('aab-alone'), person('agent-who-leads'),
      person('a', { leaderId: 'ab' }), person('b', { leaderId: 'agent-who-leads' }),
      person('moved', { leaderId: 'ab' }),
    ];
    const edges = [
      edge('a', 'ab', '2026-01-01'),
      edge('b', 'agent-who-leads', '2026-01-01'),
      // `moved` reported to the AAB from 1 to 20 August, then to the AB.
      edge('moved', 'ab', '2026-01-01'), edge('moved', 'aab-alone', '2026-08-01'), edge('moved', 'ab', '2026-08-20'),
    ];
    const audience = new OfficeAudience(people, edges);
    expect(audience.audienceOf(ask({ scope: 'leaders', startsAt: D('2026-08-10') }))).toEqual(['ab', 'aab-alone', 'agent-who-leads']);
    expect(audience.audienceOf(ask({ scope: 'leaders', startsAt: D('2026-08-25') }))).toEqual(['ab', 'agent-who-leads']);
    // Upcoming: the current graph, `leaderId`.
    expect(audience.audienceOf(ask({ scope: 'leaders', upcoming: true }))).toEqual(['ab', 'agent-who-leads']);
  });

  it('P18.2-T5 AC-3 a leader whose people had all left by then, or joined after, leads nobody then', () => {
    const audience = new OfficeAudience([
      person('lead'),
      person('gone', { status: 'removed', removedAt: D('2026-08-01') }),
      person('later', { joinedAt: D('2026-09-01') }),
    ], [
      edge('gone', 'lead', '2026-01-01'), edge('gone', null, '2026-08-01'),
      edge('later', 'lead', '2026-09-01'),
    ]);
    expect(audience.audienceOf(ask({ scope: 'leaders' }))).toEqual([]);
  });

  it('P18.2-T5 AC-3 two edges in one instant: the later written wins; a row older than the history reads its current leader', () => {
    const audience = new OfficeAudience([
      person('x'), person('y'), person('m', { leaderId: 'y' }), person('old', { leaderId: 'x' }),
    ], [edge('m', 'x', '2026-08-01', '0001'), edge('m', 'y', '2026-08-01', '0002')]);
    expect(audience.audienceOf(ask({ scope: 'leaders' }))).toEqual(['x', 'y']);
    expect(new OfficeAudience([person('x'), person('m')], [edge('m', 'x', '2026-08-01', '0002'), edge('m', null, '2026-08-01', '0001')])
      .audienceOf(ask({ scope: 'leaders' }))).toEqual(['x']);
  });

  it('P18.2-T5 AC-3 a row older than the history, re-parented after the start, reads the leader it was moved away from', () => {
    // `m` has no `joined` edge (it predates the history) and was re-parented from `x` to `y` on 1 September.
    const audience = new OfficeAudience([
      person('x'), person('y'), person('m', { leaderId: 'y' }),
    ], [edge('m', 'y', '2026-09-01', '0001', 'x')]);
    expect(audience.audienceOf(ask({ scope: 'leaders', startsAt: D('2026-08-10') }))).toEqual(['x']);
    expect(audience.audienceOf(ask({ scope: 'leaders', startsAt: D('2026-09-10') }))).toEqual(['y']);
  });

  it('P18.2-T5 AC-3 a chosen list holds its people as far as they were members then', () => {
    const audience = new OfficeAudience([
      person('chosen'), person('not-chosen'), person('chosen-late', { joinedAt: D('2026-09-01') }),
    ], []);
    const chosen = { inviteeMembershipIds: ['chosen', 'chosen-late', 'stranger'] };
    expect(audience.audienceOf(ask({ scope: 'select_agents', ...chosen }))).toEqual(['chosen']);
    expect(audience.audienceOf(ask({ scope: 'select_leaders', ...chosen, upcoming: true }))).toEqual(['chosen', 'chosen-late']);
    expect(audience.holds(ask({ scope: 'select_agents', ...chosen }), 'not-chosen')).toBe(false);
    expect(audience.holds(ask({ scope: 'select_agents', ...chosen }), 'chosen')).toBe(true);
  });
});

describe('an event’s phase and the one boundary every rule reads (P18.2-T5 AC-5; F-42)', () => {
  const event = { startsAt: new Date('2026-09-14T02:00:00Z'), endsAt: new Date('2026-09-14T05:00:00Z') };

  it('P18.2-T5 AC-5 upcoming before the start, running until the end, past from endsAt to the millisecond', () => {
    expect(eventPhase(event, new Date('2026-09-14T01:59:59.999Z'))).toBe('upcoming');
    expect(eventPhase(event, new Date('2026-09-14T02:00:00Z'))).toBe('running');
    expect(eventPhase(event, new Date('2026-09-14T04:59:59.999Z'))).toBe('running');
    expect(eventPhase(event, new Date('2026-09-14T05:00:00Z'))).toBe('past');
    expect(hasEnded(event, new Date('2026-09-14T04:59:59.999Z'))).toBe(false);
    expect(hasEnded(event, new Date('2026-09-14T05:00:00Z'))).toBe(true);
  });

  it('P18.2-T5 AC-4 the card’s time is HH:mm in the office’s zone, midnight included', () => {
    expect(localTimeOf(new Date('2026-09-14T02:00:00Z'), 'Asia/Jakarta')).toBe('09:00');
    expect(localTimeOf(new Date('2026-09-14T17:00:00Z'), 'Asia/Jakarta')).toBe('00:00');
    expect(localTimeOf(new Date('2026-09-14T11:05:00Z'), 'Asia/Jakarta')).toBe('18:05');
  });
});
