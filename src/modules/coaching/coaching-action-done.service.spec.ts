import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { CoachingActionDone, COACHING_ITEM_DONE_AUDIT_ACTION } from './coaching-action-done.service';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM = '66f0000000000000000000a1';
const RINA = '66f0000000000000000000d1';
const SESSION = '66f0000000000000000000e1';

const rina = new RequestContext('u-rina', 'none', {
  membershipId: RINA, kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/** A finalized 1:1 Rina was coached in, agreeing `RINA-1`, with what is ticked on it already. */
const session = (done: string[] = []) => ({
  _id: SESSION, coacheeMembershipId: RINA, status: 'finalized', version: 3,
  lastWeekItems: [], tips: [], leadActions: [], corrections: [], finalizedAt: NOW, finalizedByMembershipId: 'm-sari',
  actionItems: [{ itemId: 'RINA-1', text: 'Book two presentations', dueDate: '2026-09-14', carriedFromItemId: null }],
  actionItemsDone: done.map((itemId) => ({ itemId, at: NOW, byMembershipId: RINA })),
});

/**
 * **The coachee's tick, its every branch** (UI-104 point 4; the Phase 18.11 exit review, T1): the HTTP spec
 * (`calendar-auto-items.int.spec.ts`) walks who may reach it; this pins what the service does once reached — nobody's
 * membership, a tick that changes nothing, and a session that went between the read and the write.
 */
describe('CoachingActionDone.set (UI-104 point 4)', () => {
  const build = (found: unknown, written: unknown = { _id: SESSION }) => {
    const sessions = { findOne: jest.fn(async () => found), setItemDone: jest.fn(async () => written) };
    const audit = { record: jest.fn(async () => undefined) };
    return { service: new CoachingActionDone(sessions as never, audit as never, new FixedClock(NOW)), sessions, audit };
  };

  it('T1 a context with no membership — a Super Admin outside a session — is refused before anything is read', async () => {
    const { service, sessions } = build(session());

    await expect(service.set(RequestContext.platform('root'), SESSION, 'RINA-1', true))
      .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    expect(sessions.findOne).not.toHaveBeenCalled();
  });

  it('T1 ticks an open item: writes the tick with the clock’s time and records it, ids and a yes or no only', async () => {
    const { service, sessions, audit } = build(session());

    expect(await service.set(rina, SESSION, 'RINA-1', true)).toEqual({ sessionId: SESSION, itemId: 'RINA-1', done: true });
    expect(sessions.setItemDone).toHaveBeenCalledWith(rina, SESSION, RINA, { itemId: 'RINA-1', done: true, at: NOW });
    expect(audit.record).toHaveBeenCalledWith(rina, expect.objectContaining({
      action: COACHING_ITEM_DONE_AUDIT_ACTION, targetId: SESSION, targetMembershipId: RINA,
      before: { itemId: 'RINA-1', done: false }, after: { itemId: 'RINA-1', done: true },
    }));
  });

  it('T1 Urungkan takes a tick back: the write carries no time', async () => {
    const { service, sessions } = build(session(['RINA-1']));

    expect(await service.set(rina, SESSION, 'RINA-1', false)).toEqual({ sessionId: SESSION, itemId: 'RINA-1', done: false });
    expect(sessions.setItemDone).toHaveBeenCalledWith(rina, SESSION, RINA, { itemId: 'RINA-1', done: false });
  });

  it.each([
    ['ticking an item ticked already', ['RINA-1'], true],
    ['taking back a tick that is not there', [], false],
  ])('T1 %s answers where it stands, and writes and records nothing', async (_, done, asked) => {
    const { service, sessions, audit } = build(session(done));

    expect(await service.set(rina, SESSION, 'RINA-1', asked)).toEqual({ sessionId: SESSION, itemId: 'RINA-1', done: asked });
    expect(sessions.setItemDone).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('T1 a session not hers, or an item it did not agree, is 404 and nothing is written', async () => {
    for (const [found, itemId] of [[null, 'RINA-1'], [session(), 'nope']] as const) {
      const { service, sessions } = build(found);
      await expect(service.set(rina, SESSION, itemId, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(sessions.setItemDone).not.toHaveBeenCalled();
    }
  });

  it('T1 the race: a session gone between the read and the write is 404, and nothing is recorded', async () => {
    const { service, audit } = build(session(), null);

    await expect(service.set(rina, SESSION, 'RINA-1', true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('T1 a session without its tick list — stored before items could be ticked — reads as nothing ticked', async () => {
    const { service, sessions } = build({ ...session(), actionItemsDone: undefined });

    await service.set(rina, SESSION, 'RINA-1', true);
    expect(sessions.setItemDone).toHaveBeenCalled();
  });
});
