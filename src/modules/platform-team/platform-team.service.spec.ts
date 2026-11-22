import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { OWNER } from '../../../test/http-permissions';
import { PlatformTeamService } from './platform-team.service';

const ME = '66f0000000000000000000e1';
const DINA = '66f0000000000000000000e2';

/** A users model double: Dina is a Super Admin; `counts` answers `countDocuments` in turn; writes are recorded. */
function make(counts: number[]) {
  const writes: unknown[] = [];
  const users = {
    findOne: () => ({ exec: async () => ({ _id: DINA, email: 'dina@agencyboost.id', platformRole: 'super_admin' }) }),
    countDocuments: () => ({ exec: async () => counts.shift() ?? 0 }),
    updateOne: (filter: unknown, update: unknown) => {
      writes.push({ filter, update });
      return { exec: async () => ({ modifiedCount: 1 }) };
    },
    find: () => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) }),
  };
  const audit = { record: jest.fn() };
  const service = new PlatformTeamService(users as never, { liveForUserAnywhere: async () => null } as never, audit as never);
  return { service, writes, audit };
}

/** **P19.23-T6 AC-2 (ADR-0279): the rules a database cannot be asked to race in a test.** */
describe('PlatformTeamService', () => {
  it('P19.23-T6 AC-2 two removals racing: the one that would leave nobody is undone and refused SUPER_ADMIN_LAST', async () => {
    // Before the write somebody else was active; after it, nobody is — the other removal landed meanwhile.
    const { service, writes, audit } = make([1, 0]);

    const refused = await service.revoke(RequestContext.platform(ME), DINA).catch((e: unknown) => e);

    expect((refused as DomainException).code).toBe('SUPER_ADMIN_LAST');
    expect(writes).toEqual([
      { filter: { _id: DINA, platformRole: 'super_admin' }, update: { $set: { platformRole: 'none' } } },
      { filter: { _id: DINA }, update: { $set: { platformRole: 'super_admin' } } },
    ]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['list', (s: PlatformTeamService) => s.list(OWNER)],
    ['add', (s: PlatformTeamService) => s.add(OWNER, 'rudi@agencyboost.id')],
    ['revoke', (s: PlatformTeamService) => s.revoke(OWNER, DINA)],
  ])('P19.23-T6 AC-2 %s refuses a tenant role in the service too, before anything is read', async (_label, call) => {
    const { service, writes } = make([1, 1]);
    const refused = await call(service).catch((e: unknown) => e);
    expect((refused as DomainException).code).toBe('PERM_DENIED');
    expect(writes).toEqual([]);
  });
});
