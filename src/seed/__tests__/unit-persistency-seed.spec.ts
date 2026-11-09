import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { LEADER_CLASSES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';
import { seedUnitPersistency } from '../production-figures';
import { reportingUnitPersistency } from '../reporting-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/**
 * **P19.3-T1 AC-6 — the demo office's leaders carry a unit persistency** (ADR-0201 §2; the data sources' D6). Every AB
 * and AAB on 0417's files has `UNIT_PERSISTENCY` beside their own figures, imported with the file, so MOC's persistency
 * criterion and the Unit comparison have the insurer's figure to read on a fresh seed — but **Winda's is not on this
 * month's file**, as her persistency is not, so *Belum diunggah* is seen too. An agent's row carries none.
 */
describe('P19.3-T1 AC-6 the seeded unit persistency — a run at 10:00 on 9 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-09T03:00:00Z'));
  const THIS_MONTH = '2026-10';
  const LAST_MONTH = '2026-09';
  let kpmId: string;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    kpmId = String((await col('kpms').findOne({ code: '0417' }))!._id);
  }, RUN_MS);
  afterAll(stopMongo);

  const membersOf = async () => col('memberships').find({ kpmId, status: 'active', deletedAt: null }).toArray();
  const rowsOf = async (month: string) => new Map((await col('monthlyAgentData').find({ kpmId, month, deletedAt: null }).toArray())
    .map((row) => [String(row.membershipId), row]));
  const nameOf = async (membership: { userId: string }) =>
    (await col('users').findOne({ _id: new mongoose.Types.ObjectId(membership.userId) }))!.fullName as string;

  it('P19.3-T1 AC-6 every leader on this month’s standing file has one, imported with it; no agent has one', async () => {
    const rows = await rowsOf(THIS_MONTH);
    const standing = (await col('dataUploadBatches').find({ kpmId, month: THIS_MONTH, status: 'committed' }).toArray())[0];
    let leaders = 0;
    for (const m of await membersOf()) {
      const row = rows.get(String(m._id));
      if (!row || row.values?.APE?.value == null) continue;
      const cell = row.values.UNIT_PERSISTENCY;
      if ((LEADER_CLASSES as readonly string[]).includes(m.role)) {
        if ((await nameOf(m as never)) === 'Winda Anggraeni') continue;
        leaders += 1;
        expect([m.agentCode, cell.provenance, cell.sourceBatchId]).toEqual([m.agentCode, 'imported', String(standing._id)]);
        expect(cell.value).toBeGreaterThanOrEqual(0);
        expect(cell.value).toBeLessThanOrEqual(100);
      } else {
        expect([m.agentCode, cell?.value ?? null]).toEqual([m.agentCode, null]);
      }
    }
    // The Owner's, the Admin's, Agus's, Yosef's and Satria's agencies, and their AABs: more than a handful.
    expect(leaders).toBeGreaterThanOrEqual(5);
    // The file that carried it was read against the template's version 1, and its undo log names the cell by kode
    // (P19.5-T2), so a revert gives it back.
    expect(standing.analyticsConfig).toMatchObject({ version: 1 });
    const uploadRows = await col('dataUploadRows').find({ batchId: String(standing._id) }).toArray();
    expect(uploadRows.some((r) => typeof r.values.UNIT_PERSISTENCY === 'number')).toBe(true);
    expect(standing.cellCount).toBe(uploadRows.reduce((n, r) => n + Object.keys(r.values).length, 0));
  });

  it('P19.3-T1 AC-6 the reporting cast keeps its MOC story: Yosef 88, Satria 70, Winda’s not on this month’s file', async () => {
    const rows = await rowsOf(THIS_MONTH);
    const last = await rowsOf(LAST_MONTH);
    const byName = new Map<string, { _id: unknown }>();
    for (const m of await membersOf()) byName.set(await nameOf(m as never), m);
    const unit = (map: Map<string, { values?: Record<string, { value: number | null }> }>, name: string) =>
      map.get(String(byName.get(name)!._id))?.values?.UNIT_PERSISTENCY?.value ?? null;
    expect(unit(rows as never, 'Yosef Tambunan')).toBe(88);
    expect(unit(rows as never, 'Satria Nugraha')).toBe(70);
    expect(unit(rows as never, 'Winda Anggraeni')).toBeNull();
    expect(unit(last as never, 'Winda Anggraeni')).toBe(85);
    // An agent of theirs: none, on either file.
    expect(unit(rows as never, 'Arini Kusuma')).toBeNull();
    expect(reportingUnitPersistency('arini', THIS_MONTH, THIS_MONTH)).toBeNull();
  });

  it('P19.3-T1 AC-6 the month table shows it on the leader’s row, and the Owner reads it through the service', async () => {
    const kpm = await col('kpms').findOne({ code: '0417' });
    const account = await col('users').findOne({ email: 'owner@kpm0417.test' });
    const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
    const owner = new RequestContext(String(member.userId), 'none', {
      membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
      status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    } as never).withReader(SOURCE_READER);
    const view = await wired.production.readMonth(owner, THIS_MONTH);
    const yosef = view.rows.find((r) => r.name === 'Yosef Tambunan')!;
    expect(yosef).toMatchObject({ leader: true, values: { UNIT_PERSISTENCY: { value: 88, provenance: 'imported' } } });
    const arini = view.rows.find((r) => r.name === 'Arini Kusuma')!;
    expect(arini).toMatchObject({ leader: false, values: { UNIT_PERSISTENCY: { value: null } } });
  });

  it('P19.3-T1 AC-6 a seeded figure is a percentage with one place, different per leader and month', () => {
    const values = [0, 1, 2, 3, 4, 5].flatMap((i) => ['2026-09', '2026-10'].map((m) => seedUnitPersistency(i, m)));
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(76);
      expect(v).toBeLessThan(95);
      expect(Math.round(v * 10)).toBe(v * 10);
    }
    expect(new Set(values).size).toBeGreaterThan(6);
  });
});
