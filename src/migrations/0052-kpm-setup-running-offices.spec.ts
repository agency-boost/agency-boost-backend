import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0052-kpm-setup-running-offices';

const NOW = new Date('2026-11-05T02:00:00Z');
const EARLIER = new Date('2026-11-01T02:00:00Z');
const RUNNING = '66f0000000000000000000f1';
const NEW = '66f0000000000000000000f2';
const NO_UPLOAD = '66f0000000000000000000f3';
const GONE = '66f0000000000000000000f4';

/**
 * **`0052-kpm-setup-running-offices`** (P19.3-T2; UI-149's *Done when*, *"Staging KPM 0417 (members, upload, target
 * present) shows no card"*): a running office's four settings pages are marked; a new one is left for its Owner.
 */
describe('0052-kpm-setup-running-offices', () => {
  const db = () => mongoose.connection.db!;
  const marks = (kpmId: string) => db().collection('kpmSetupMarks').find({ kpmId }).sort({ mark: 1 }).toArray();

  beforeAll(startMongo, 120_000);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const c of ['kpms', 'memberships', 'dataUploadBatches', 'kpmSetupMarks']) await db().collection(c).deleteMany({});
    await db().collection('kpms').insertMany([RUNNING, NEW, NO_UPLOAD, GONE].map((id) => ({
      _id: new mongoose.Types.ObjectId(id), code: id.slice(-4), ownerUserId: `owner-${id}`, deletedAt: id === GONE ? EARLIER : null,
    })));
    const member = (kpmId: string, userId: string) => ({ kpmId, userId, status: 'active', deletedAt: null });
    await db().collection('memberships').insertMany([
      member(RUNNING, `owner-${RUNNING}`), member(RUNNING, 'u-agus'),
      member(NEW, `owner-${NEW}`),
      member(NO_UPLOAD, `owner-${NO_UPLOAD}`), member(NO_UPLOAD, 'u-nadia'),
      member(GONE, `owner-${GONE}`), member(GONE, 'u-gone'),
    ]);
    await db().collection('dataUploadBatches').insertMany([
      { kpmId: RUNNING, month: '2026-09', status: 'committed', deletedAt: null },
      // The Owner alone with a file: not running — nobody else uses the settings yet.
      { kpmId: NEW, month: '2026-11', status: 'committed', deletedAt: null },
      { kpmId: NO_UPLOAD, month: '2026-11', status: 'reverted', deletedAt: null },
      { kpmId: GONE, month: '2026-09', status: 'committed', deletedAt: null },
    ]);
  });

  it('P19.3-T2 AC-4 marks a running office’s four pages, via migration, and leaves the others for their Owner', async () => {
    expect(await up(db(), NOW)).toEqual({ marked: 1, current: 0, setup: 2 });
    expect((await marks(RUNNING)).map((m) => [m.mark, m.via])).toEqual([
      ['activation-checklist', 'migration'], ['activity-types', 'migration'], ['branch-info', 'migration'], ['products', 'migration'],
    ]);
    expect(await marks(NEW)).toEqual([]);
    expect(await marks(NO_UPLOAD)).toEqual([]);
    expect(await marks(GONE)).toEqual([]);
  });

  it('P19.3-T2 AC-5 keeps a mark already there, whatever made it, and a second run marks none', async () => {
    await db().collection('kpmSetupMarks').insertOne({ kpmId: RUNNING, mark: 'products', via: 'reviewed', at: EARLIER, deletedAt: null });
    expect(await up(db(), NOW)).toEqual({ marked: 1, current: 0, setup: 2 });
    expect((await marks(RUNNING)).find((m) => m.mark === 'products')).toMatchObject({ via: 'reviewed', at: EARLIER });
    expect(await up(db(), NOW)).toEqual({ marked: 0, current: 1, setup: 2 });
    expect(await marks(RUNNING)).toHaveLength(4);
  });
});
