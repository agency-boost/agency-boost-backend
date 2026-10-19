import { RequestContext } from '@/common/context/request-context';
import type { CoachResolver } from '@/modules/org/coach-resolver';
import type { MemberNames, NamedPerson } from '@/modules/org/member-names.service';
import type { OrgLevelService } from '@/modules/tenants/org-level.service';
import type { TenantDay } from '@/modules/tenants/tenant-day.service';
import { CoacheeService } from './coachee.service';

const READER = 'm-reader';
const SUBJECT = 'm-subject';

const reader = new RequestContext('u-reader', 'none', {
  membershipId: READER, kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **What the person read answers when a fact cannot be named** (P11-T7 AC-1): the fallbacks
 * `coachee.int.spec.ts`'s office never reaches, because every one of its members has a user, a leader
 * with a name and a rung on the company's ladder. Each is a real row in a long-lived office: a user
 * erased under PDP, a rung the company has since retired, an office provisioned before companies.
 */
describe('the person a coaching page opens on, when a fact cannot be named (P11-T7)', () => {
  function service(over: {
    people?: Map<string, NamedPerson>;
    companyId?: string | null;
    ladder?: { code: string; label: string }[];
    orgLevelCode?: string;
  } = {}) {
    const coach = {
      coachee: jest.fn().mockResolvedValue({ leaderId: READER, orgLevelCode: over.orgLevelCode ?? 'AGENT' }),
      coacheesOf: jest.fn().mockResolvedValue([]),
    } as unknown as CoachResolver;
    const names = {
      people: jest.fn().mockResolvedValue(over.people ?? new Map([
        [SUBJECT, { name: 'Rina Wijaya', pronoun: 'she' }], [READER, { name: 'Agus Salim', pronoun: 'he' }],
      ])),
    } as unknown as MemberNames;
    const list = jest.fn().mockResolvedValue(over.ladder ?? [{ code: 'AGENT', label: 'Agent' }]);
    const orgLevels = { list } as unknown as OrgLevelService;
    const days = {
      office: jest.fn().mockResolvedValue({
        today: '2026-10-02', companyId: over.companyId === undefined ? 'c-1' : over.companyId,
      }),
    } as unknown as TenantDay;
    return { svc: new CoacheeService(coach, names, orgLevels, days), list };
  }

  it('P11-T7 AC-1 names the person and their leader from the directory, and the rung from the company’s ladder', async () => {
    const { svc } = service();
    expect(await svc.read(reader, SUBJECT)).toEqual({
      today: '2026-10-02', membershipId: SUBJECT, name: 'Rina Wijaya', pronoun: 'she', rung: { code: 'AGENT', label: 'Agent' },
      leader: { membershipId: READER, name: 'Agus Salim' }, direct: true, downline: { members: 0, leaders: 0 },
    });
  });

  it('P11-T7 AC-1 a leader who can no longer be named is null, and a person with no user reads blank and they', async () => {
    const { svc } = service({ people: new Map() });
    expect(await svc.read(reader, SUBJECT)).toMatchObject({ name: '', pronoun: 'they', leader: null });
  });

  it('P11-T7 AC-1 a rung the ladder no longer lists is labelled by its code', async () => {
    const { svc } = service({ orgLevelCode: 'SENIOR_AGENT' });
    expect((await svc.read(reader, SUBJECT)).rung).toEqual({ code: 'SENIOR_AGENT', label: 'SENIOR_AGENT' });
  });

  it('P11-T7 AC-1 an office with no company reads no ladder, and labels the rung by its code', async () => {
    const { svc, list } = service({ companyId: null });
    expect((await svc.read(reader, SUBJECT)).rung).toEqual({ code: 'AGENT', label: 'AGENT' });
    expect(list).not.toHaveBeenCalled();
  });
});
