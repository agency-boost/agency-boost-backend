import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { isWholeMonths } from '@/domain/metrics/campaign-window';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in an office, as a signed-in context. */
async function as(code: string, email: string): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
  } as never).withReader(SOURCE_READER); // the API's English, as asserted here: nobody's choice reads Indonesian (P18.98-T4)
}

/**
 * **Phase 18.5 — campaigns, seeded** (P18.5-T7 AC-11, P18.5-T8, P18.5-T9; `campaigns-fixture.ts`, whose header says which
 * account shows what). The seed run as the command runs it, at 10:00 on Saturday 10 October 2026 in Jakarta, read back
 * through the campaigns module's own services, and run a second time to prove it writes nothing.
 */
describe('Phase 18.5 the campaigns seed — a run at 10:00 on 10 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-10T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;
  let kpm0417: string;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    kpm0417 = String((await col('kpms').findOne({ code: '0417' }))!._id);
  }, RUN_MS);
  afterAll(stopMongo);

  it('P18.5-T7 AC-11 writes eight campaigns and eight chases in 0417, one campaign in 0555, and no standing of its own', async () => {
    const codes = (await col('campaigns').find({ kpmId: kpm0417 }).toArray()).map((c) => c.code).sort();
    expect(codes).toEqual([
      'APE_CHALLENGE_NEXT', 'APE_SPRINT', 'ARCHIVED_DRIVE', 'MDRT_QUALIFICATION', 'NEW_HIRE_BLITZ', 'PERSISTENCY_PUSH',
      'PROMOTION_AAB_AB', 'PROMOTION_AGENT_AAB', 'RECRUIT_SPRINT', 'YEAR_END_DRIVE',
    ]);
    expect(await col('campaignChases').countDocuments({ kpmId: kpm0417 })).toBe(8);
    const kpm0555 = String((await col('kpms').findOne({ code: '0555' }))!._id);
    expect(await col('campaigns').countDocuments({ kpmId: kpm0555, code: 'GADING_PUSH' })).toBe(1);
    // *Amended 2026-10-10 (P18.6-T3, D-seed a):* the compliance fixture runs after this one and overrides Budi's final
    // standing in the push, through the campaigns module's own write — the first read after September locked, which
    // freezes the push's window: its two chasers, and nothing else.
    expect((await col('campaignStandings').find({}).toArray()).map((s) => s.campaignCode)).toEqual(['PERSISTENCY_PUSH', 'PERSISTENCY_PUSH']);
    expect(seeded.campaigns.written).toBe(8 + 1 + 8);
    // Phase 5's two, given the card's fields by the migration; the drive snapped to whole office months.
    const drive = (await col('campaigns').findOne({ kpmId: kpm0417, code: 'YEAR_END_DRIVE' }))!;
    expect(drive).toMatchObject({ kind: 'seasonal', window: 'campaign_dates', blurb: '' });
    expect(isWholeMonths(drive.startsAt, drive.endsAt, 'Asia/Jakarta')).toBe(true);
  });

  it('P18.5-T7 AC-2 Rina’s list: both tabs, every section, a star on her three', async () => {
    const list = await wired.campaignAgent.list(await as('0417', 'rina@kpm0417.test'));
    expect(list.campaigns.map((c) => [c.code, c.phase, c.chasing])).toEqual([
      ['APE_SPRINT', 'running', true],
      ['NEW_HIRE_BLITZ', 'running', false],
      ['YEAR_END_DRIVE', 'running', false],
      ['APE_CHALLENGE_NEXT', 'upcoming', false],
      ['PERSISTENCY_PUSH', 'ended', true],
      ['RECRUIT_SPRINT', 'ended', false],
      ['MDRT_QUALIFICATION', 'running', true],
      ['PROMOTION_AAB_AB', 'running', false],
      ['PROMOTION_AGENT_AAB', 'running', false],
    ]);
    const card = (code: string) => list.campaigns.find((c) => c.code === code)!;
    expect(card('PERSISTENCY_PUSH').chaseBlocked).toBe('ended');
    expect(card('PROMOTION_AAB_AB').chaseBlocked).toBe('not_eligible');
    expect(card('APE_SPRINT').title).toBe('Agu–Okt APE Sprint');
    expect(card('APE_CHALLENGE_NEXT').title).toBe('Q1 2027 APE Challenge');
  });

  it('P18.5-T8 AC-6 the sprint’s dialog: APE ✓, and New Hire Not uploaded yet over the month before last', async () => {
    const detail = await wired.campaignAgent.detail(await as('0417', 'rina@kpm0417.test'), 'APE_SPRINT');
    expect(detail.progress!.rows.map((r) => [r.metricKey, r.state])).toEqual([['APE_ACHIEVED', 'met'], ['NEW_HIRES', 'not_uploaded']]);
    expect(detail.progress!.windowLabel).toBe('Agu – Okt 2026');
  });

  it('P18.5-T8 AC-5 the persistency push is final on its first read: Rina qualified, Budi not met, and nobody else stored', async () => {
    const rina = await as('0417', 'rina@kpm0417.test');
    const budi = await as('0417', 'budi@kpm0417.test');
    expect((await wired.campaignAgent.detail(rina, 'PERSISTENCY_PUSH')).progress).toMatchObject({ final: true });
    const read = await wired.campaignStandingsReader.ofOffice(rina, { codes: ['PERSISTENCY_PUSH'] });
    const of = (id: string) => read.standings.find((s) => s.membershipId === id)!;
    expect(of(rina.membershipId!)).toMatchObject({ chasing: true, status: 'qualified', final: true });
    // *Amended 2026-10-10 (P18.6-T3, D-seed a):* Budi's frozen *Not met* is overridden *Achieved* by the Owner; every
    // reader reads the override, and the stored status stays the frozen one. His dialog's rows do not change.
    expect(of(budi.membershipId!)).toMatchObject({ chasing: true, status: 'qualified', final: true, overridden: { status: 'qualified' } });
    expect((await col('campaignStandings').findOne({ campaignCode: 'PERSISTENCY_PUSH', membershipId: budi.membershipId }))!.status)
      .toBe('not_met');
    expect((await col('campaignStandings').find({ campaignCode: 'PERSISTENCY_PUSH' }).toArray()).map((s) => s.membershipId).sort())
      .toEqual([rina.membershipId, budi.membershipId].sort());
  });

  it('P18.5-T7 AC-6 the Summary cards: Rina two rows, the ended one dropped; Budi none', async () => {
    const rina = await wired.campaignAgent.chasing(await as('0417', 'rina@kpm0417.test'), undefined);
    expect(rina.campaigns.map((c) => c.code)).toEqual(['APE_SPRINT', 'MDRT_QUALIFICATION']);
    expect((await wired.campaignAgent.chasing(await as('0417', 'budi@kpm0417.test'), undefined)).campaigns).toEqual([]);
  });

  it('P18.5-T7 AC-7 Agus’s roster: his own ✓, Dimas ✓, Rina ✓ — and one chaser over the MDRT figure', async () => {
    const agus = await as('0417', 'agus@kpm0417.test');
    const view = await wired.unitDashboard.read(
      new RequestContext(agus.userId, 'none', { ...agus.membership!, directCount: 3 }).withReader(agus.reader),
    );
    const rows = [...view.yourUnit.rows, ...view.units.flatMap(function all(g): typeof view.yourUnit.rows {
      return [g.head, ...g.members, ...g.units.flatMap(all)];
    })];
    const ticked = rows.filter((r) => r.chasingMdrt).map((r) => r.name).sort();
    expect(ticked).toEqual(['Agus Prasetyo', 'Dimas Pratama', 'Rina Wijaya'].sort());
    expect(view.mdrt.running).toBe(true);
    // The target as ADR-0167 §1 writes a rule's sum: compact where that is exact, in full where it would round.
    expect(view.mdrt.tooltip).toMatch(/^Chasing MDRT \(Million Dollar Round Table\) this year — APE of Rp (\d{1,3}(\.\d{3})*(,\d)? (rb|jt|M)|\d{1,3}(\.\d{3})*) or more\.$/);
    const mdrt = (await wired.campaignStandingsReader.ofOffice(agus, { codes: ['MDRT_QUALIFICATION'] })).standings;
    expect(mdrt.filter((s) => s.status === 'qualified')).toHaveLength(1);
  });

  it('P18.5-T7 AC-11 a second run writes nothing', async () => {
    const before = await col('campaignChases').countDocuments({});
    const second = await seedDemo({ clock, log: quiet });
    expect(second.campaigns.written).toBe(0);
    expect(await col('campaignChases').countDocuments({})).toBe(before);
  }, RUN_MS);
});
