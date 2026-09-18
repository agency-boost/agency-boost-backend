import { checkEvent, checkEventType } from './event-input';

/**
 * Reading one event body (P5-T6).
 *
 * The rules are here rather than in the DTO because they **collect every violation before
 * refusing** (ADR-0030): a form with three mistakes hears about three, not one at a time.
 */
describe('reading an event body', () => {
  const valid = {
    code: 'KICKOFF', typeCode: 'TRAINING', title: 'Kickoff 2026',
    startsAt: '2026-10-01T02:00:00Z', endsAt: '2026-10-01T06:00:00Z',
    audience: { issuer: 'kpm', scope: 'all_agents' },
  };

  it('takes a whole event, normalising the codes and the instants', () => {
    const read = checkEvent({ ...valid, code: 'kickoff', typeCode: 'training' });

    expect(read.code).toBe('KICKOFF');
    expect(read.typeCode).toBe('TRAINING');
    expect(read.startsAt?.toISOString()).toBe('2026-10-01T02:00:00.000Z');
    expect(read.audience).toEqual({
      issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [],
    });
  });

  it('collects every violation rather than stopping at the first', () => {
    // Somebody who got three things wrong should hear about three.
    let message = '';
    try {
      checkEvent({ title: '', audience: { issuer: 'x', scope: 'y' } });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/code is required/);
    expect(message).toMatch(/audience.issuer/);
    expect(message).toMatch(/audience.scope/);
    expect(message).toMatch(/startsAt is required/);
  });

  it('refuses a date that is not one, and an end before a start', () => {
    expect(() => checkEvent({ ...valid, startsAt: 'next tuesday' }))
      .toThrow(/startsAt is not a date and time/);
    expect(() => checkEvent({ ...valid, endsAt: '2026-10-01T01:00:00Z' }))
      .toThrow(/endsAt must be after startsAt/);
  });

  it('refuses an audience that is not an object, and a missing one', () => {
    expect(() => checkEvent({ ...valid, audience: 'KPM | All agents' }))
      .toThrow(/audience must be an object/);
    const { audience, ...noAudience } = valid;
    expect(() => checkEvent(noAudience)).toThrow(/audience is required/);
  });

  it('refuses an invitee list on a scope that invites everybody it describes', () => {
    // A body meaning two things at once: "everybody" and "these four people".
    expect(() => checkEvent({
      ...valid,
      audience: { issuer: 'kpm', scope: 'leaders', inviteeMembershipIds: ['a'] },
    })).toThrow(/takes no invitee list/);
  });

  it('refuses an invitee list that is not a list, and de-duplicates one that is', () => {
    expect(() => checkEvent({
      ...valid, audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: 'a' },
    })).toThrow(/must be a list/);

    const read = checkEvent({
      ...valid,
      audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: ['a', 'a', 'b'] },
    });
    expect(read.audience.inviteeMembershipIds).toEqual(['a', 'b']);
  });

  it('refuses a field nobody declared, rather than dropping it silently', () => {
    expect(() => checkEvent({ ...valid, colour: 'red' })).toThrow(/colour should not exist/);
  });

  it('lets a partial change leave everything else alone', () => {
    const read = checkEvent({ title: 'Moved' }, { partial: true });

    expect(read.title).toBe('Moved');
    expect(read.startsAt).toBeUndefined();
  });

  it('takes an optional link, and nulls an empty one', () => {
    expect(checkEvent({ ...valid, locationUrl: ' https://maps.test/x ' }).locationUrl)
      .toBe('https://maps.test/x');
    expect(checkEvent({ ...valid, locationUrl: '' }).locationUrl).toBeNull();
    expect(checkEvent({ ...valid, locationUrl: null }).locationUrl).toBeNull();
    expect(() => checkEvent({ ...valid, locationUrl: 42 })).toThrow(/locationUrl must be text/);
  });
});

describe('reading an event type body', () => {
  it('takes a type, and nulls an emoji nobody gave', () => {
    const read = checkEventType({ code: 'town_hall', label: 'Town hall' });

    expect(read.code).toBe('TOWN_HALL');
    expect(read.emoji).toBeUndefined();
  });

  it('refuses a colour that is not a hex value', () => {
    // The poster is an emoji on a background: a token would not travel into an inline style.
    expect(() => checkEventType({ code: 'X_TYPE', label: 'X', color: 'blue' }))
      .toThrow(/hex value/);
    expect(checkEventType({ code: 'X_TYPE', label: 'X', color: '#2D9CDB' }).color)
      .toBe('#2D9CDB');
  });

  it('requires a code and a label on a create, and neither on a change', () => {
    expect(() => checkEventType({})).toThrow(/code is required/);
    expect(checkEventType({ label: 'Renamed' }, { partial: true }))
      .toEqual({ label: 'Renamed' });
  });
});
