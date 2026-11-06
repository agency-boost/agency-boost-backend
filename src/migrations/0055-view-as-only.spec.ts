import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up, VIEW_AS_ONLY_ACTOR } from './0055-view-as-only';

const DEPLOY = new Date('2026-11-06T02:00:00Z');
const EARLIER = new Date('2026-11-05T09:00:00Z');
const LATER = new Date('2026-11-06T03:00:00Z');
const KPM = '66f0000000000000000000a1';

/**
 * **`0055-view-as-only`** (P19.4-T2 AC-1; ADR-0206 §5; UI-151): a session started as *Penyiapan*, or elevated to write,
 * that is still open at the deploy is ended there, with its reason and its audit entry; nothing else is touched.
 */
describe('0055-view-as-only', () => {
  const db = () => mongoose.connection.db!;
  const sessions = () => db().collection('impersonationSessions');
  const audit = () => db().collection('auditLog');

  beforeAll(startMongo, 120_000);
  afterAll(stopMongo);

  /** One session row as `ImpersonationService.start` wrote it before P19.4-T2, with what differs. */
  const row = (id: string, over: Record<string, unknown>) => ({
    _id: new mongoose.Types.ObjectId(id), realActorUserId: 'sa-victor', effectiveUserId: `u-${id.slice(-2)}`,
    kpmId: KPM, tokenHash: `hash-${id}`, readOnly: true, purpose: 'support', writeScope: [], elevatedByUserId: null,
    elevatedAt: null, reason: 'Uploading training PDFs', elevationReason: null, startedAt: EARLIER,
    expiresAt: LATER, endedAt: null, deletedAt: null, ...over,
  });
  const SETUP = '66f0000000000000000000b1';
  const ELEVATED = '66f0000000000000000000b2';
  const LOOKING = '66f0000000000000000000b3';
  const SETUP_ENDED = '66f0000000000000000000b4';
  const SETUP_EXPIRED = '66f0000000000000000000b5';
  const SETUP_GONE = '66f0000000000000000000b6';
  const SETUP_NO_OFFICE = '66f0000000000000000000b7';

  beforeEach(async () => {
    await clearCollections();
    for (const c of ['impersonationSessions', 'auditLog']) await db().collection(c).deleteMany({});
    await sessions().insertMany([
      row(SETUP, { purpose: 'setup', writeScope: ['tenant_config:write', 'kpm:import_roster'] }),
      row(ELEVATED, { readOnly: false, elevatedByUserId: 'sa-2', elevatedAt: EARLIER, elevationReason: 'A role.' }),
      row(LOOKING, {}),
      row(SETUP_ENDED, { purpose: 'setup', endedAt: EARLIER }),
      row(SETUP_EXPIRED, { purpose: 'setup', expiresAt: EARLIER }),
      row(SETUP_GONE, { purpose: 'setup', deletedAt: EARLIER }),
      row(SETUP_NO_OFFICE, { purpose: 'setup', kpmId: null }),
    ]);
  });

  const byId = async (id: string) => sessions().findOne({ _id: new mongoose.Types.ObjectId(id) });

  it('P19.4-T2 AC-1 ends every open setup or elevated session at the deploy, view_as_only, and leaves the rest', async () => {
    expect(await up(db(), DEPLOY)).toEqual({ ended: 4 });
    for (const id of [SETUP, ELEVATED, SETUP_EXPIRED, SETUP_NO_OFFICE]) {
      expect(await byId(id)).toMatchObject({ endedAt: DEPLOY, endReason: 'view_as_only' });
    }
    // A session that only looks runs on; one already ended keeps its end; a deleted row is not read.
    expect(await byId(LOOKING)).toMatchObject({ endedAt: null });
    expect((await byId(LOOKING))?.endReason).toBeUndefined();
    expect(await byId(SETUP_ENDED)).toMatchObject({ endedAt: EARLIER });
    expect((await byId(SETUP_ENDED))?.endReason).toBeUndefined();
    expect(await byId(SETUP_GONE)).toMatchObject({ endedAt: null, deletedAt: EARLIER });
  });

  it('P19.4-T2 AC-1 keeps each row’s history: purpose, scope and elevation as they were', async () => {
    await up(db(), DEPLOY);
    expect(await byId(SETUP)).toMatchObject({
      purpose: 'setup', readOnly: true, writeScope: ['tenant_config:write', 'kpm:import_roster'],
    });
    expect(await byId(ELEVATED)).toMatchObject({
      purpose: 'support', readOnly: false, elevatedByUserId: 'sa-2', elevationReason: 'A role.',
    });
  });

  it('P19.4-T2 AC-1 writes impersonation.ended for each, in its office, naming the person, the session and why', async () => {
    await up(db(), DEPLOY);
    const entries = await audit().find({ action: 'impersonation.ended' }).sort({ 'after.sessionId': 1 }).toArray();
    expect(entries.map((e) => [e.kpmId, e.targetId, e.after.sessionId])).toEqual([
      [KPM, 'u-b1', SETUP], [KPM, 'u-b2', ELEVATED], [KPM, 'u-b5', SETUP_EXPIRED], [null, 'u-b7', SETUP_NO_OFFICE],
    ]);
    expect(entries[0]).toMatchObject({
      actorUserId: VIEW_AS_ONLY_ACTOR, effectiveUserId: VIEW_AS_ONLY_ACTOR, targetCollection: 'users',
      after: { reason: 'view_as_only', sessionId: SETUP, startedBy: 'sa-victor' }, createdAt: DEPLOY,
    });
  });

  it('P19.4-T2 AC-1 is idempotent: a second run ends nothing and writes no second entry', async () => {
    await up(db(), DEPLOY);
    expect(await up(db(), new Date('2026-11-07T02:00:00Z'))).toEqual({ ended: 0 });
    expect(await audit().countDocuments({ action: 'impersonation.ended' })).toBe(4);
    expect(await byId(SETUP)).toMatchObject({ endedAt: DEPLOY });
  });

  it('P19.4-T2 AC-1 writes one end when the operator ends the session between the read and the write', async () => {
    const realUpdate = sessions().updateOne.bind(sessions());
    const spy = jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne').mockImplementationOnce(async function (
      this: mongoose.mongo.Collection, filter, update,
    ) {
      // The operator's own end lands first.
      await realUpdate({ _id: new mongoose.Types.ObjectId(SETUP) }, { $set: { endedAt: EARLIER } });
      return realUpdate(filter, update);
    });
    try {
      expect(await up(db(), DEPLOY)).toEqual({ ended: 3 });
    } finally {
      spy.mockRestore();
    }
    expect(await byId(SETUP)).toMatchObject({ endedAt: EARLIER });
    expect(await audit().countDocuments({ 'after.sessionId': SETUP })).toBe(0);
  });

  it('P19.4-T2 AC-1 does nothing on an empty database', async () => {
    await sessions().deleteMany({});
    expect(await up(db(), DEPLOY)).toEqual({ ended: 0 });
    expect(await audit().countDocuments({})).toBe(0);
  });
});
