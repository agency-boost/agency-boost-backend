import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES, SEED_RATIO_DEFINITIONS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { LONG_PIPELINE } from '../long-pipeline';
import { seedDemo } from '../demo';

/**
 * **P13.1-T3 — the seed follows the prototype** (`phase-13.1-client-revisions-iii.md`, K5): office 0417's
 * settings are the platform's defaults, published and untouched; the settings screens' demonstration
 * states are office 0555's; and one 0417 Agent, Budi, holds more than 30 open leads.
 *
 * Run as the command runs it, and read back through the configuration's and the leads' own services
 * where a screen reads them, so what is asserted is what the Owner's publish bar and an agent's
 * `/leads` show.
 */
const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function office(code: string): Promise<string> {
  return String((await col('kpms').findOne({ code }))!._id);
}

async function memberOf(email: string) {
  const account = await col('users').findOne({ email });
  return (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
}

async function as(email: string, owner = false): Promise<RequestContext> {
  const member = await memberOf(email);
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: owner, isKpmAdmin: false, directCount: 0,
  } as never);
}

describe('P13.1-T3 the seed follows the prototype — a run at 10:00 on 7 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-07T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
  }, RUN_MS);
  afterAll(stopMongo);

  it('AC-2 office 0417 holds the platform defaults: nothing archived, no ratio of its own, no edit', async () => {
    const kpmId = await office('0417');
    const types = await col('activityTypes').find({ kpmId }).sort({ displayOrder: 1 }).toArray();
    expect(types.map((t) => [t.code, t.label, t.status, t.version]))
      .toEqual(SEED_ACTIVITY_TYPES.map((t) => [t.code, t.label, 'active', 1]));

    const statuses = await col('leadStatuses').find({ kpmId }).sort({ pipeline: -1, rank: 1 }).toArray();
    expect(statuses.map((s) => [s.code, s.status, s.version]))
      .toEqual(SEED_LEAD_STATUSES.map((s) => [s.code, 'active', 1]));

    // The platform's five, at its benchmarks: no *Rasio referral*, *Selling success rate* at 30% (ADR-0160).
    const ratios = await col('ratioDefinitions').find({ kpmId }).sort({ displayOrder: 1 }).toArray();
    expect(ratios.map((r) => [r.code, r.label, r.benchmark, r.origin, r.status, r.version]))
      .toEqual(SEED_RATIO_DEFINITIONS.map((r) => [r.code, r.label, r.benchmark, 'platform', 'active', 1]));
  });

  it('AC-2 0417’s publish bar reads clean, and item 7 reaches its agents under the client’s label', async () => {
    const owner = await as('owner@kpm0417.test', true);
    expect(await wired.config.state(owner)).toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: false });

    const published = await wired.config.readPublished(await as('rina@kpm0417.test'));
    const item7 = published.activity.flatMap((c) => c.types).find((t) => t.code === 'RECRUIT_PRESENTATION');
    // The client's words since ADR-0160 (P18.5-T8 AC-2), with no note.
    expect(item7).toMatchObject({ label: 'Melakukan presentasi recruitment', description: null });
  });

  it('AC-2 office 0555 holds the demonstration states, after its publish, so its bar has something to say', async () => {
    const kpmId = await office('0555');
    expect(await col('activityTypes').findOne({ kpmId, code: 'DEV_COACHING_RECEIVED' }))
      .toMatchObject({ status: 'archived', version: 2 });
    expect(await col('leadStatuses').findOne({ kpmId, code: 'APPROVED_NOT_PAID' }))
      .toMatchObject({ status: 'archived', version: 2 });
    expect(await col('ratioDefinitions').findOne({ kpmId, code: 'SELLING_SUCCESS_RATE' }))
      .toMatchObject({ benchmark: 0.4, version: 2, status: 'active' });
    expect(await col('ratioDefinitions').findOne({ kpmId, code: 'REFERRAL_RATE' }))
      .toMatchObject({ origin: 'office', label: 'Rasio referral', status: 'active' });

    expect(await wired.config.state(await as('owner@kpm0555.test', true)))
      .toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: true });
    // Lina is still on the published copy: the archived type offered, the old benchmark, no office ratio.
    const lina = await wired.config.readPublished(await as('agent@kpm0555.test'));
    expect(lina.activity.flatMap((c) => c.types).map((t) => t.code)).toContain('DEV_COACHING_RECEIVED');
    expect(lina.ratios.find((r) => r.code === 'SELLING_SUCCESS_RATE')).toMatchObject({ benchmark: 0.3 });
    expect(lina.ratios.map((r) => r.code)).not.toContain('REFERRAL_RATE');
  });

  it('AC-3 Budi’s /leads holds more than 30 open leads, each remark and note one line, none promised', async () => {
    const budi = await memberOf('budi@kpm0417.test');
    const page = await wired.leadRecords.list(await as('budi@kpm0417.test'), { outcome: 'open' });
    expect(page.total).toBe(42);
    expect(page.total).toBeGreaterThan(30);

    const open = await col('leads').find({ ownerMembershipId: String(budi._id), outcome: null, deletedAt: null }).toArray();
    for (const lead of open) {
      expect({ name: lead.name, remarks: /\n/.test(lead.remarks ?? ''), note: /\n/.test(lead.nextActionNote ?? '') })
        .toEqual({ name: lead.name, remarks: false, note: false });
    }
    // Promised for no month: every coachee holds exactly one promise for this one (`coaching-cast.ts`).
    const named = new Set(LONG_PIPELINE.map((l) => l.name));
    expect(open.filter((l) => named.has(l.name) && l.commitments.length > 0)).toEqual([]);
    // No lawful basis written: the field is retired (ADR-0108).
    expect(open.filter((l) => named.has(l.name) && (l.lawfulBasis ?? null) !== null)).toEqual([]);
  });

  it('AC-3 the pipeline spans his weeks: both ladders, every stage but recruitment’s last, Unassigned, all after he joined', async () => {
    const budi = await memberOf('budi@kpm0417.test');
    const mine = await col('leads').find({ ownerMembershipId: String(budi._id) }).toArray();
    const pipeline = mine.filter((l) => LONG_PIPELINE.some((p) => p.name === l.name));
    expect(pipeline).toHaveLength(LONG_PIPELINE.length);

    const held = new Set(pipeline.map((l) => `${l.type}:${l.statusCode}`));
    for (const status of SEED_LEAD_STATUSES.filter((s) => !s.isTerminal || s.pipeline === 'sales')) {
      expect({ status: status.code, held: held.has(`${status.pipeline}:${status.code}`) })
        .toEqual({ status: status.code, held: true });
    }
    expect(held.has('null:null')).toBe(true);

    const joined = (budi.joinedAt as Date).getTime();
    for (const lead of pipeline) {
      const moves = (lead.transitions as { at: Date }[]).map((t) => t.at.getTime());
      expect({ name: lead.name, ordered: [...moves].sort((a, b) => a - b) })
        .toEqual({ name: lead.name, ordered: moves });
      expect({ name: lead.name, afterJoining: (lead.dateRegistered as Date).getTime() > joined })
        .toEqual({ name: lead.name, afterJoining: true });
      if (moves.length) expect(moves[0]).toBe((lead.dateRegistered as Date).getTime());
    }
    // Registered across the months he worked, not on one day.
    const months = new Set(pipeline.map((l) => clock.localDateFor('Asia/Jakarta', l.dateRegistered as Date).slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(2);
  });

  it('P18.5-T7 AC-1 Rina’s /leads opens in the order she dragged, and every seeded lead has a place', async () => {
    const page = await wired.leadRecords.list(await as('rina@kpm0417.test'), { outcome: 'open' });
    expect(page.rows.map((lead) => lead.name).slice(0, 6)).toEqual([
      'Ibu Wulan Sari', 'Pak Hendro Gunawan', 'Ibu Rosa Damayanti', 'Ibu Kartika Dewanti', 'Pak Surya Dharma', 'Pak Bambang',
    ]);
    // P19.1-T3 AC-12: this week's Tugas (`tugas-fixture.ts`), which the dragged order does not name, after it.
    expect(page.rows.map((lead) => lead.name).slice(6).sort())
      .toEqual(['Ibu Shinta Wardhani', 'Ibu Wening Sari', 'Pak Gunawan Saleh']);
    // Not the order registration would give: that is the point of seeding it.
    const byRegistration = await wired.leadRecords.list(await as('rina@kpm0417.test'), { outcome: 'open', sort: 'dateRegistered' });
    expect(byRegistration.rows.map((lead) => lead.name)).not.toEqual(page.rows.map((lead) => lead.name));
    expect(await col('leads').countDocuments({ position: null })).toBe(0);
  });

  it('a second run writes nothing, and leaves a 0555 row somebody restored in a walk as they left it', async () => {
    const kpmId = await office('0555');
    // Restored on the settings screen, which bumps the version: the walker's, not the seed's to undo.
    await col('activityTypes').updateOne(
      { kpmId, code: 'DEV_COACHING_RECEIVED' }, { $set: { status: 'active', archivedAt: null, version: 3 } },
    );
    const again = await seedDemo({ clock, log: quiet });
    expect(again.written).toEqual({});
    expect(await col('activityTypes').findOne({ kpmId, code: 'DEV_COACHING_RECEIVED' }))
      .toMatchObject({ status: 'active', version: 3 });
    expect(await col('ratioDefinitions').findOne({ kpmId, code: 'SELLING_SUCCESS_RATE' }))
      .toMatchObject({ benchmark: 0.4, version: 2 });
    expect(await col('ratioDefinitions').countDocuments({ kpmId, code: 'REFERRAL_RATE' })).toBe(1);
  }, RUN_MS);
});
