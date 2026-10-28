import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { freshItemState } from './activation-rules';
import { activationNavFor, NO_ACTIVATION_NAV, type ActivationNav } from './activation-nav.port';
import { signalActivation, type ActivationEvents } from './activation-events.port';
import {
  startActivationHarness, stopActivationHarness, type ActivationHarness, type Who,
} from '../../../test/activation-office';

const AGENT_CTX = new RequestContext('u-1', 'none', {
  membershipId: 'm-1', kpmId: 'k-1', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});

/**
 * **The edges the happy paths do not reach**: the ports failing open, a write that loses a race with a
 * graduation, and a name the office no longer holds.
 */
describe('the activation’s ports fail open (P13-T1 AC-2, P13-T3 AC-5, P13-T7 AC-5)', () => {
  it('P13-T3 AC-5 a write with no evaluator wired signals nothing, and one that throws is swallowed', async () => {
    await expect(signalActivation(null, AGENT_CTX, 'm-1', 'feature:goals')).resolves.toBeUndefined();
    const failing = { recorded: jest.fn().mockRejectedValue(new Error('down')) } as unknown as ActivationEvents;
    await expect(signalActivation(failing, AGENT_CTX, 'm-1', 'feature:leads')).resolves.toBeUndefined();
    expect(failing.recorded).toHaveBeenCalledWith(AGENT_CTX, 'm-1', 'feature:leads');
  });

  it('P13-T7 AC-5 a session whose facts cannot be read still loads, showing nothing', async () => {
    const failing = { factsFor: jest.fn().mockRejectedValue(new Error('down')) } as unknown as ActivationNav;
    await expect(activationNavFor(failing, AGENT_CTX)).resolves.toEqual(NO_ACTIVATION_NAV);
    await expect(activationNavFor(null, AGENT_CTX)).resolves.toEqual(NO_ACTIVATION_NAV);
    await expect(activationNavFor(failing, RequestContext.platform('root'))).resolves.toEqual(NO_ACTIVATION_NAV);
    expect(failing.factsFor).toHaveBeenCalledTimes(1);
  });
});

describe('a write that loses a race with a graduation, and a name the office no longer holds', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => {
    await h.reset();
    jest.restoreAllMocks();
  });

  /** The write itself finds the activation graduated between the read and the write. */
  const graduatedMidway = () => jest.spyOn(h.wired.activationRows, 'updateItems').mockResolvedValueOnce(null);

  it('P13-T2 AC-3 a tick, a start date and a note that land after a graduation are refused, closed', async () => {
    await h.start('RINA', '2026-07-18');
    // Rina has a goal: the read before each write completes her goal item, then the write itself loses.
    h.as('RINA');
    await h.http().get('/activation/me').expect(200);

    graduatedMidway();
    expect((await h.http().put('/activation/me/items/CRM_SETUP').send({ done: true }).expect(409)).body.error.code).toBe('ACTIVATION_CLOSED');
    h.as('SARI');
    graduatedMidway();
    expect((await h.http().put(`/new-hires/${id('RINA')}/start-date`).send({ startDate: '2026-07-01' }).expect(409)).body.error.code).toBe('ACTIVATION_CLOSED');
    graduatedMidway();
    expect((await h.http().put(`/new-hires/${id('RINA')}/note`).send({ text: 'Late' }).expect(409)).body.error.code).toBe('ACTIVATION_CLOSED');
    expect(await h.col('auditLog').countDocuments({ action: { $regex: '^activation\\.' } })).toBe(0);
  });

  /** Budi's activation with every item ticked by him: complete, and open. */
  async function complete() {
    const doc = await h.start('BUDI', '2026-07-15');
    await h.col('activationProgress').updateOne({ _id: doc._id }, {
      $set: { items: doc.items.map((i) => ({ ...freshItemState(i.code), done: true, source: 'hire', doneByMembershipId: id('BUDI'), doneAt: new Date() })) },
    });
    return doc;
  }

  /** Graduation's own write, with `between` landing after its read and before it. */
  function interleave(between: () => Promise<unknown>) {
    const rows = h.wired.activationRows;
    const real = rows.updateItems.bind(rows);
    return jest.spyOn(rows, 'updateItems').mockImplementation(async (ctx, filter, update, arrayFilters) => {
      if (update.$set && 'graduatedAt' in update.$set) await between();
      return real(ctx, filter, update, arrayFilters);
    });
  }

  it('P13-T7 AC-6 a graduation that lands after another is refused, closed', async () => {
    const doc = await complete();
    interleave(() => h.col('activationProgress').updateOne({ _id: doc._id }, { $set: { graduatedAt: new Date(), graduatedByMembershipId: id('BUDI') } }));
    h.as('BUDI');
    expect((await h.http().post('/activation/me/graduate').expect(409)).body.error).toMatchObject({ code: 'ACTIVATION_CLOSED', details: { state: 'graduated' } });
    expect(await h.col('auditLog').countDocuments({ action: 'activation.graduated' })).toBe(0);
  });

  it('Phase 13 exit review N2 an untick that lands between graduation’s read and its write: refused ACTIVATION_INCOMPLETE on a re-read, nothing graduated', async () => {
    const doc = await complete();
    // Sari unticks one of Budi's items after his graduation has read him at 100%, before it writes.
    interleave(() => h.wired.newHires.tick(h.office.as('SARI'), id('BUDI'), 'ROLE_PLAY', { done: false }));
    h.as('BUDI');
    const res = await h.http().post('/activation/me/graduate').expect(409);
    expect(res.body.error).toMatchObject({ code: 'ACTIVATION_INCOMPLETE', details: { done: 15, total: 16 } });
    expect(await h.col('activationProgress').findOne({ _id: doc._id })).toMatchObject({ graduatedAt: null, graduatedByMembershipId: null });
    expect((await h.col('auditLog').find({ action: { $regex: '^activation\\.' } }).toArray()).map((r) => r.action)).toEqual(['activation.item_unticked']);
  });

  it('Phase 13 exit review N2 the one case left — unticked and ticked again in between — is VERSION_CONFLICT, to read afresh; nothing graduated', async () => {
    const doc = await complete();
    h.as('BUDI');
    graduatedMidway();
    const res = await h.http().post('/activation/me/graduate').expect(409);
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 1 } });
    expect(await h.col('activationProgress').findOne({ _id: doc._id })).toMatchObject({ graduatedAt: null });
    // Read afresh, it graduates.
    jest.restoreAllMocks();
    await h.http().post('/activation/me/graduate').expect(200);
  });

  it('P13-T4 AC-5 a tick by somebody the office no longer holds keeps its attribution, with no name to print', async () => {
    const gone = new mongoose.Types.ObjectId().toString();
    const doc = await h.start('BUDI', '2026-07-15');
    await h.col('activationProgress').updateOne({ _id: doc._id, 'items.code': 'ROLE_PLAY' }, {
      $set: { 'items.$.done': true, 'items.$.source': 'leader', 'items.$.doneByMembershipId': gone, 'items.$.doneAt': new Date() },
    });
    h.as('BUDI');
    const view = (await h.http().get('/activation/me').expect(200)).body;
    const item = view.aspects.flatMap((a: { items: { code: string }[] }) => a.items).find((i: { code: string }) => i.code === 'ROLE_PLAY');
    expect(item).toMatchObject({ done: true, doneBy: { membershipId: gone, name: '' } });
  });
});
