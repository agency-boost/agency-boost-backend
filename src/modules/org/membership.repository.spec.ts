import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { MembershipRepository } from './membership.repository';

/**
 * **The named unscoped count refuses everyone but the Super Admin** (invariant §1; ADR-0156 §5). It answers how many
 * live members stand on a rung across every office of the company, so its only caller is the ladder's editor; anyone
 * else meets the tenancy backstop before the database is asked anything.
 */
describe('MembershipRepository.countHoldingRungAcrossTenants', () => {
  // No model method is reachable before the guard: a stub that throws if touched proves it.
  const untouchable = new Proxy({}, { get: () => { throw new Error('the model was asked'); } });
  const repository = new MembershipRepository(untouchable as never);

  it('P18.8-T1 AC-2 refuses a caller who is not a Super Admin, asking the database nothing', async () => {
    const member = new RequestContext('66f00000000000000000aa02', 'none', null);
    await expect(repository.countHoldingRungAcrossTenants(member, '66f0000000000000000000d1'))
      .rejects.toBeInstanceOf(MissingTenantContextError);
  });
});
