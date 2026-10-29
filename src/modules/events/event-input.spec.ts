import { readerIn } from '@/common/i18n/reader';
import type { DomainException } from '@/common/errors/domain.exception';
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

    // Membership ids, since the Phase 18.5 exit review: anything else is a malformed body, never a lookup.
    const a = '66f0000000000000000000aa';
    const b = '66f0000000000000000000bb';
    const read = checkEvent({
      ...valid,
      audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [a, a, b] },
    });
    expect(read.audience.inviteeMembershipIds).toEqual([a, b]);
  });

  it('P18.5-T5 AC-9 refuses an invitee that is not a membership id, and a location link that is not a web address', () => {
    expect(() => checkEvent({
      ...valid, audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: ['a', 'b'] },
    })).toThrow(/2 value\(s\) that are not membership ids/);
    expect(() => checkEvent({ ...valid, locationUrl: 'javascript:alert(1)' })).toThrow(/must be a web address/);
    expect(checkEvent({ ...valid, locationUrl: 'http://maps.example.test/?q=x' }).locationUrl).toBe('http://maps.example.test/?q=x');
    expect(checkEvent({ ...valid, locationUrl: null }).locationUrl).toBeNull();
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

/**
 * **The bodies nobody sends on purpose** (the Phase 18.5 exit review, module coverage): no body at all, an audience
 * with nothing in it, a type change that names only its description, a link too long. Each is refused, or read,
 * the way a deliberate body is.
 */
describe('reading the bodies nobody sends on purpose (P18.5 exit review)', () => {
  it('P18.5-T5 AC-9 no body at all is every required field missing, never a server fault', () => {
    expect(() => checkEvent(null)).toThrow(/code is required/);
    expect(() => checkEventType(undefined)).toThrow(/code is required/);
  });

  it('P18.5-T5 AC-9 an audience with no issuer or scope names both', () => {
    expect(() => checkEvent({ audience: {} }, { partial: true })).toThrow(/audience.issuer is one of.*audience.scope is one of/);
  });

  it('P18.5-T5 AC-9 a type change naming only its description changes only that', () => {
    expect(checkEventType({ description: 'For the whole office' }, { partial: true })).toEqual({ description: 'For the whole office' });
  });

  it('P18.5-T5 AC-9 a location link over 500 characters is refused', () => {
    expect(() => checkEvent({ locationUrl: `https://x.test/${'a'.repeat(500)}` }, { partial: true }))
      .toThrow(/locationUrl is at most 500 characters/);
  });
});

/** **The same refusals, in Bahasa Indonesia** (P18.98-T5 AC-3): each violation a sentence, the message them all. */
describe('P18.98-T5 AC-3 an event body’s violations, in both languages', () => {
  const refused = (read: () => unknown): DomainException => {
    try {
      read();
    } catch (err) {
      return err as DomainException;
    }
    throw new Error('expected a refusal');
  };

  it('P18.98-T5 AC-3 every field sentence reads in Indonesian; the English, the message and the code are unchanged', () => {
    const err = refused(() => checkEvent({
      code: 'KICKOFF', typeCode: 'TRAINING', title: 'Kickoff', startsAt: 'next tuesday', endsAt: '2026-10-01T06:00:00Z',
      locationUrl: 42, audience: { issuer: 'kpm', scope: 'leaders', inviteeMembershipIds: ['a', 'b'] },
    }));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.details).toEqual({ violations: [
      'locationUrl must be text.',
      'startsAt is not a date and time.',
      'audience.inviteeMembershipIds holds 2 value(s) that are not membership ids.',
      'audience.scope "leaders" invites everybody it describes, so it takes no invitee list.',
    ] });
    const id = err.detailsFor(readerIn('id')) as { violations: string[] };
    expect(id.violations).toEqual([
      'locationUrl harus berupa teks.',
      'startsAt bukan tanggal dan waktu yang valid.',
      'audience.inviteeMembershipIds berisi 2 nilai yang bukan ID anggota.',
      'audience.scope "leaders" mengundang semua orang yang dicakupnya, jadi tidak menerima daftar undangan.',
    ]);
    expect(err.messageFor(readerIn('id'))).toBe(id.violations.join('; '));
  });

  it('P18.98-T5 AC-3 a type’s colour, a missing audience, a text too long and an audience that is not an object', () => {
    const say = (read: () => unknown) => refused(read).detailsFor(readerIn('id'));
    expect(say(() => checkEventType({ code: 'CLINIC', label: 'Clinic', color: 'blue' })))
      .toEqual({ violations: ['color harus berupa nilai hex, misalnya #2D9CDB.'] });
    expect(say(() => checkEventType({ code: 'CLINIC', label: 'Clinic', emoji: '🩺🩺🩺🩺🩺' })))
      .toEqual({ violations: ['emoji paling banyak 8 karakter.'] });
    expect(say(() => checkEvent({ audience: 'KPM | All agents' }, { partial: true })))
      .toEqual({ violations: ['audience harus berupa objek berisi kolom.'] });
    expect(say(() => checkEvent({ audience: { issuer: 'kpm', scope: 'x', inviteeMembershipIds: 'a' } }, { partial: true })))
      .toEqual({ violations: [
        'audience.scope harus salah satu dari: all_agents, select_agents, leaders, select_leaders.',
        'audience.inviteeMembershipIds harus berupa daftar.',
      ] });
    const { violations } = say(() => checkEvent({})) as { violations: string[] };
    expect(violations).toEqual(expect.arrayContaining(['code wajib diisi.', 'audience wajib diisi.', 'endsAt wajib diisi.']));
  });
});
