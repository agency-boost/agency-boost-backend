import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0031-lead-position';

/**
 * P18.8-T7 AC-1. Every lead gets a place in its owner's list, newest registration first — the order the
 * screen opened on before the field existed — so nobody's list moves on deploy.
 */
describe('0031 — a lead’s place in its owner’s list', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const leads = () => db().collection('leads');

  const KPM_A = '66f0000000000000000000a1';
  const KPM_B = '66f0000000000000000000b1';
  const day = (d: number) => new Date(`2026-09-${String(d).padStart(2, '0')}T02:00:00Z`);

  beforeEach(async () => {
    await clearCollections();
    await leads().deleteMany({});
  });

  /** A lead as it was written before the field: no `position` at all. */
  const old = (name: string, owner: string, registered: Date | null, over: Record<string, unknown> = {}) => ({
    kpmId: KPM_A, ownerMembershipId: owner, name, type: 'sales', outcome: null,
    dateRegistered: registered, deletedAt: null, version: 3, updatedBy: 'mem-leader', ...over,
  });

  const order = async (owner: string, kpmId = KPM_A) =>
    (await leads().find({ kpmId, ownerMembershipId: owner }).sort({ position: 1 }).toArray()).map((l) => l.name);

  it('P18.8-T7 AC-1 places each owner’s leads newest registration first, from 0', async () => {
    await leads().insertMany([
      old('Sep 3', 'mem-rina', day(3)),
      old('Sep 20', 'mem-rina', day(20)),
      old('Sep 11', 'mem-rina', day(11)),
      old('Budi, Sep 5', 'mem-budi', day(5)),
      old('Budi, Sep 9', 'mem-budi', day(9)),
    ] as never);

    const result = await up(db());

    expect(result).toEqual({ placed: 5, owners: 2 });
    expect(await order('mem-rina')).toEqual(['Sep 20', 'Sep 11', 'Sep 3']);
    expect((await leads().find({ ownerMembershipId: 'mem-rina' }).sort({ position: 1 }).toArray()).map((l) => l.position))
      .toEqual([0, 1, 2]);
    expect(await order('mem-budi')).toEqual(['Budi, Sep 9', 'Budi, Sep 5']);
  });

  it('P18.8-T7 AC-1 places a closed and a deleted lead too, and a lead with no date last', async () => {
    await leads().insertMany([
      old('Undated', 'mem-rina', null),
      old('Won', 'mem-rina', day(2), { outcome: 'won' }),
      old('Deleted', 'mem-rina', day(4), { deletedAt: day(10) }),
      old('Open', 'mem-rina', day(1)),
    ] as never);

    await up(db());

    expect(await order('mem-rina')).toEqual(['Deleted', 'Won', 'Open', 'Undated']);
  });

  it('P18.8-T7 AC-1 keeps each office’s lists apart, and breaks a tie on the date by the id, newest first', async () => {
    const [first, second] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await leads().insertMany([
      old('Same day, made first', 'mem-x', day(8), { _id: first }),
      old('Same day, made second', 'mem-x', day(8), { _id: second }),
      old('Office B', 'mem-x', day(30), { kpmId: KPM_B }),
    ] as never);

    await up(db());

    expect(await order('mem-x')).toEqual(['Same day, made second', 'Same day, made first']);
    expect((await leads().findOne({ name: 'Office B' }))!.position).toBe(0);
  });

  it('P18.8-T7 AC-1 puts unplaced leads below the ones the new code already placed', async () => {
    await leads().insertMany([
      old('Added after deploy', 'mem-rina', day(25), { position: -1 }),
      old('Dragged to the top', 'mem-rina', day(1), { position: 0 }),
      old('Older, unplaced', 'mem-rina', day(12)),
      old('Oldest, unplaced', 'mem-rina', day(2)),
    ] as never);

    const result = await up(db());

    expect(result).toEqual({ placed: 2, owners: 1 });
    expect(await order('mem-rina')).toEqual(['Added after deploy', 'Dragged to the top', 'Older, unplaced', 'Oldest, unplaced']);
    expect((await leads().findOne({ name: 'Older, unplaced' }))!.position).toBe(1);
  });

  it('P18.8-T7 AC-1 touches nothing but the place: not the version, the editor or the outcome', async () => {
    await leads().insertOne(old('Pak Budi', 'mem-rina', day(5)) as never);

    await up(db());

    expect(await leads().findOne({ name: 'Pak Budi' })).toMatchObject({
      position: 0, version: 3, updatedBy: 'mem-leader', outcome: null,
    });
  });

  it('P18.8-T7 AC-1 is a no-op the second time, and on an empty database', async () => {
    expect(await up(db())).toEqual({ placed: 0, owners: 0 });
    await leads().insertMany([old('A', 'mem-rina', day(3)), old('B', 'mem-rina', day(4))] as never);
    await up(db());
    const before = await leads().find({}).sort({ _id: 1 }).toArray();

    expect(await up(db())).toEqual({ placed: 0, owners: 0 });
    expect(await leads().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });
});
