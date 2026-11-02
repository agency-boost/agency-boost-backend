import { RequestContext } from '@/common/context/request-context';
import { CalendarPeopleService } from './calendar-people.service';

const KPM = '66f0000000000000000000a1';
const as = (membershipId: string | null, rung = 'AB') => new RequestContext('u', 'none', membershipId === null ? null : {
  membershipId, kpmId: KPM, orgLevelCode: rung, hierarchyRole: rung.toLowerCase(), status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

interface Member { _id: string; leaderId: string | null; ancestorIds: string[]; orgLevelCode: string; role: string }
const m = (id: string, leaderId: string | null, ancestorIds: string[], orgLevelCode = 'AGENT', role = 'agent'): Member =>
  ({ _id: id, leaderId, ancestorIds, orgLevelCode, role });

/**
 * **The picker's and the compare list's own edges**, with the collaborators stubbed: a name that cannot be
 * read, a rung no ladder names, an office with no company, two people with one name, and the reader's own
 * row missing from the read. The HTTP specs walk the office; these pin what a gap in it answers.
 */
describe('CalendarPeopleService', () => {
  function build(input: {
    members: Member[];
    names?: Record<string, string>;
    companyId?: string | null;
    ladder?: { code: string; label: string }[];
    coachees?: { membershipId: string; depth: number; membership: Member }[];
  }) {
    const names = new Map(Object.entries(input.names ?? {}));
    return new CalendarPeopleService(
      { find: async () => input.members } as never,
      { coacheesOf: async () => input.coachees ?? [] } as never,
      { byMembershipId: async () => names } as never,
      { list: async () => input.ladder ?? [{ code: 'AGENT', label: 'Agent' }, { code: 'AB', label: 'AB' }] } as never,
      { office: async () => ({ companyId: input.companyId === undefined ? 'company' : input.companyId }) } as never,
    );
  }

  it('answers TENANT_NO_MEMBERSHIP to a caller in no office', async () => {
    await expect(build({ members: [] }).people(as(null), {})).rejects.toMatchObject({ response: { code: 'TENANT_NO_MEMBERSHIP' } });
    await expect(build({ members: [] }).downline(as(null))).rejects.toMatchObject({ response: { code: 'TENANT_NO_MEMBERSHIP' } });
  });

  it('an office with no company has no ladder, so nobody is a field member to list', async () => {
    const service = build({ members: [m('me', null, [], 'AB', 'ab'), m('x', 'me', ['me'])], companyId: null });
    expect((await service.people(as('me'), {})).items).toEqual([]);
  });

  it('a name it cannot read is empty and a leader it cannot name is null; two of one name are ordered by id', async () => {
    const service = build({
      members: [m('me', null, [], 'AB', 'ab'), m('b', 'me', ['me']), m('a', 'me', ['me']), m('c', 'gone', ['gone'])],
      names: { a: 'Ani', b: 'Ani' },
    });
    const { items } = await service.people(as('me'), {});
    expect(items.map((r) => [r.membershipId, r.name, r.leaderName, r.direct, r.group])).toEqual([
      ['a', 'Ani', null, true, 'direct_unit'], ['b', 'Ani', null, true, 'direct_unit'], ['c', '', null, false, 'other'],
    ]);
  });

  it('a reader missing from the read has nobody above them', async () => {
    const service = build({ members: [m('x', null, []), m('y', 'x', ['x'])], names: { x: 'Xena', y: 'Yuda' } });
    expect((await service.people(as('me'), {})).items.map((r) => r.group)).toEqual(['other', 'other']);
  });

  it('a cursor that is JSON of the wrong shape is refused', async () => {
    const service = build({ members: [m('me', null, [], 'AB', 'ab')] });
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    for (const bad of [{ g: 'x', p: [] }, { g: 1, p: [['only one']] }, { g: 1, p: 'x' }, null]) {
      await expect(service.people(as('me'), { cursor: cursor(bad) })).rejects.toMatchObject({ response: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('the compare list labels a rung no ladder names by its code, and a person it cannot name as empty', async () => {
    const lead = m('lead', 'me', ['me'], 'MANAGER', 'aab');
    const service = build({
      members: [],
      coachees: [{ membershipId: 'lead', depth: 1, membership: lead }],
      names: {},
    });
    expect((await service.downline(as('me'))).people).toEqual([{
      membershipId: 'lead', name: '', rung: { code: 'MANAGER', label: 'MANAGER' }, leaderName: null, direct: true, depth: 1, group: 'group',
    }]);
  });

  it('the compare list orders two of one name by id, and a picker key by id either way round', async () => {
    const one = m('b2', 'me', ['me']);
    const two = m('a1', 'me', ['me']);
    const service = build({
      members: [m('me', null, [], 'AB', 'ab'), m('z9', 'me', ['me']), m('a0', 'me', ['me'])],
      coachees: [{ membershipId: 'b2', depth: 1, membership: one }, { membershipId: 'a1', depth: 1, membership: two }],
      names: { b2: 'Ani', a1: 'Ani', z9: 'Ani', a0: 'Ani' },
    });
    expect((await service.downline(as('me'))).people.map((p) => p.membershipId)).toEqual(['a1', 'b2']);
    expect((await service.people(as('me'), {})).items.map((p) => p.membershipId)).toEqual(['a0', 'z9']);
  });

  it('P12-T4 AC-1 the picker orders three of one name by id, in whatever order the read returns them', async () => {
    const namesakes = [m('z9', 'me', ['me']), m('a0', 'me', ['me']), m('m5', 'me', ['me'])];
    const names = { z9: 'Ani', a0: 'Ani', m5: 'Ani' };
    for (const order of [namesakes, [...namesakes].reverse()]) {
      const service = build({ members: [m('me', null, [], 'AB', 'ab'), ...order], names });
      expect((await service.people(as('me'), {})).items.map((p) => p.membershipId)).toEqual(['a0', 'm5', 'z9']);
    }
  });

  it('a leader who coaches nobody is answered nobody, and an Agent is not asked', async () => {
    expect(await build({ members: [] }).downline(as('me'))).toEqual({ people: [] });
    expect(await build({ members: [], coachees: [{ membershipId: 'x', depth: 1, membership: m('x', 'me', ['me']) }] })
      .downline(as('me', 'AGENT'))).toEqual({ people: [] });
  });
});
