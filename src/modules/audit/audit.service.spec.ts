import { RequestContext } from '@/common/context/request-context';
import { AuditService } from './audit.service';

function makeService(createImpl?: jest.Mock) {
  const created: Record<string, unknown>[] = [];
  const create = createImpl ?? jest.fn(async (d: Record<string, unknown>) => { created.push(d); return d; });
  const model = {
    create,
    find: jest.fn(() => ({ sort: () => ({ limit: () => ({ exec: async () => [] }) }) })),
  };
  return { service: new AuditService(model as never), created, model, create };
}

const agentCtx = new RequestContext('u1', 'none', {
  membershipId: 'mem-agent', kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});

describe('AuditService', () => {
  it('records the acting membership and tenant', async () => {
    const { service, created } = makeService();
    await service.record(agentCtx, {
      action: 'goal.saved', targetCollection: 'goals', targetId: 'g1',
    });
    expect(created[0]).toMatchObject({
      kpmId: 'kpm-a', actorUserId: 'u1', actorMembershipId: 'mem-agent',
      action: 'goal.saved', effectiveUserId: null, onBehalfOf: false,
    });
  });

  it('flags onBehalfOf when a leader acts on someone else’s record', async () => {
    const leaderCtx = new RequestContext('u2', 'none', {
      membershipId: 'mem-leader', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    });
    const { service, created } = makeService();
    await service.record(leaderCtx, {
      action: 'goal.override', targetCollection: 'goals',
      targetId: 'g1', targetMembershipId: 'mem-agent',
    });
    expect(created[0].onBehalfOf).toBe(true);
  });

  it('records both actors during impersonation', async () => {
    const impersonated = new RequestContext('u-agent', 'none', {
      membershipId: 'mem-agent', kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent',
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    }, 'u-superadmin');
    const { service, created } = makeService();
    await service.record(impersonated, { action: 'lead.viewed', targetCollection: 'leads' });

    expect(created[0]).toMatchObject({
      actorUserId: 'u-superadmin',
      effectiveUserId: 'u-agent',
    });
  });

  it('records a platform action with a null tenant', async () => {
    const { service, created } = makeService();
    await service.record(RequestContext.platform('root'), {
      action: 'kpm.created', targetCollection: 'kpms', targetId: 'kpm-new',
    });
    expect(created[0].kpmId).toBeNull();
  });

  it('never lets an audit failure take down the operation it describes', async () => {
    const failing = jest.fn(async () => { throw new Error('mongo down'); });
    const { service } = makeService(failing);
    const logger = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    await expect(
      service.record(agentCtx, { action: 'x', targetCollection: 'y' }),
    ).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalled();
  });

  it('reads back tenant entries newest first', async () => {
    const { service, model } = makeService();
    await service.findForTenant('kpm-a', 10);
    expect(model.find).toHaveBeenCalledWith({ kpmId: 'kpm-a' });
  });

  it('queries the null scope literally, so platform events are readable', async () => {
    // A Super Admin has no membership. Coercing their null tenant to '' would query a
    // scope nothing is ever written under and return an empty log that looks correct.
    const { service, model } = makeService();
    await service.findForTenant(null, 10);
    expect(model.find).toHaveBeenCalledWith({ kpmId: null });
  });
});
