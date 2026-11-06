import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in an office, as a signed-in context. */
async function as(code: string, email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false, directCount: 0,
  } as never);
}

const idOf = async (email: string, code = '0417') => String((await as(code, email)).membershipId);

/**
 * **P19.5-T4 AC-20 — the surveys, seeded** (`surveys-fixture.ts`; ADR-0216 §10). The seed run as the command runs it, at
 * 10:00 on Thursday 5 November 2026 in Jakarta, then read back through the surveys' own services, so what is asserted is
 * what each account of the fixture's header table sees on a fresh seed — and a second run writes no survey row.
 */
describe('P19.5-T4 AC-20 the surveys seed — a run at 10:00 on 5 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-05T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('AC-20 the periods: this quarter’s NPS open, last quarter’s closed, June’s qualitative run in both offices', () => {
    expect(seeded.surveys.periods).toEqual({ npsOpen: '2026-Q4', npsPrevious: '2026-Q3', qual: '2026-06' });
  });

  it('C-R2, C-R6 Indah: the open NPS, 1 of 6 answered, a dot and a card; the halfway popup she never saw', async () => {
    const pending = await wired.surveys.member.pending(await as('0417', 'indah@kpm0417.test'));
    expect(pending.open).toEqual([expect.objectContaining({
      runId: seeded.surveys.runs.npsOpen, periodKey: '2026-Q4', opensOn: '2026-10-27', closesOn: '2026-11-09',
      answeredCount: 1, totalCount: 6, daysLeft: 4, anonymous: true,
    })]);
    // The halfway day was the 2nd and its popup has not been shown: today's Home shows it — "Anda sudah menjawab 1 dari 6".
    expect(pending.popup).toEqual({ moment: 'halfway', runIds: [seeded.surveys.runs.npsOpen] });
    const form = await wired.surveys.member.form(await as('0417', 'indah@kpm0417.test'), seeded.surveys.runs.npsOpen);
    expect(form).toMatchObject({ resumeIndex: 1, answeredCount: 1, run: { notice: 'anonymous' } });
  });

  it('C-R9 Dimas sent it: the thank-you line, and Riwayat lists last quarter’s only for those who sent it', async () => {
    const dimas = await as('0417', 'dimas@kpm0417.test');
    expect(await wired.surveys.member.pending(dimas)).toMatchObject({ open: [], sentOpen: [{ runId: seeded.surveys.runs.npsOpen }] });
    const agus = await wired.surveys.member.list(await as('0417', 'agus@kpm0417.test'));
    expect(agus.history.map((h) => h.periodKey)).toEqual(['2026-Q3']);
    expect(agus.open.map((o) => o.periodKey)).toEqual(['2026-Q4']);
  });

  it('ADR-0216 §3 the anonymous forms hold no person: no membership, no time, no author', async () => {
    const rows = await col('surveyResponses').find({ runId: { $in: [seeded.surveys.runs.npsOpen, seeded.surveys.runs.npsPrevious] } }).toArray();
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row).toMatchObject({ membershipId: null, submittedAt: null, createdBy: null });
  });

  it('B4-1 Agus opens Indah: Penjualan 4 for Jun 2026, no Q12', async () => {
    const view = await wired.surveys.coaching.read(await as('0417', 'agus@kpm0417.test'), await idOf('indah@kpm0417.test'));
    expect(view).toMatchObject({ state: 'answered', run: { periodKey: '2026-06', closesOn: '2026-06-30' } });
    expect(view.issueCounts.map((c) => [c.kode, c.count])).toEqual([['SALES', 4]]);
    expect(JSON.stringify(view)).not.toMatch(/Q12|sering mendampingi/);
  });

  it('B4-3 Arief, an AAB, answered as the mockup’s Ika: Penjualan tim, Rekrutmen, Aktivasi, Manajemen unit — no downline card', async () => {
    const view = await wired.surveys.coaching.read(await as('0417', 'agus@kpm0417.test'), await idOf('arief@kpm0417.test'));
    expect(view.sections.map((s) => s.kode)).toEqual(['SALES', 'RECRUIT', 'ACTIVATION', 'UNIT']);
    expect(view.issueCounts.map((c) => c.count)).toEqual([2, 6, 4, 9]);
  });

  it('B4-5 Sari was invited and has not answered; Dimas was never invited — Belum ada survei', async () => {
    const agus = await as('0417', 'agus@kpm0417.test');
    expect((await wired.surveys.coaching.read(agus, await idOf('sari@kpm0417.test'))).state).toBe('not_answered');
    expect((await wired.surveys.coaching.read(agus, await idOf('dimas@kpm0417.test'))).state).toBe('none');
  });

  it('the Owner opens Yosef (AB, the mockup’s Fajar): Coaching leader downline, Winda’s three areas', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const view = await wired.surveys.coaching.read(owner, await idOf('yosef@kpm0417.test'));
    const downline = view.sections.find((s) => s.kind === 'downline');
    expect(downline).toMatchObject({ stillCoaching: true, leaders: [{ name: 'Winda Anggraeni' }] });
  });

  it('B4-4 0555’s Owner opens Lina: the June run was anonymous, nothing is sent', async () => {
    const owner = await as('0555', 'owner@kpm0555.test', { owner: true });
    const linaId = (await col('surveyParticipation').findOne({ runId: seeded.surveys.runs.qualAnonymous0555 }))!.membershipId as string;
    expect(await wired.surveys.coaching.read(owner, linaId)).toMatchObject({ state: 'anonymous', sections: [] });
  });

  it('AC-3 the Owner’s NPS tab: Q4 running with 3 sent, Q3 closed with 5, its open answers with no names', async () => {
    const owner = await as('0417', 'owner@kpm0417.test', { owner: true });
    const tab = await wired.surveys.kpm.results(owner, 'nps');
    expect(tab.runs.map((r) => [r.periodKey, r.state, r.responses.sent])).toEqual([['2026-Q4', 'open', 3], ['2026-Q3', 'closed', 5]]);
    const q3 = await wired.surveys.kpm.results(owner, 'nps', seeded.surveys.runs.npsPrevious);
    expect(q3.selected!.nps!.openAnswers).toHaveLength(3);
  });

  it('a second run writes no survey row', async () => {
    const before = await Promise.all(['surveyRuns', 'surveyParticipation', 'surveyResponses'].map((c) => col(c).countDocuments()));
    await seedDemo({ clock, log: quiet });
    const after = await Promise.all(['surveyRuns', 'surveyParticipation', 'surveyResponses'].map((c) => col(c).countDocuments()));
    expect(after).toEqual(before);
  }, RUN_MS);
});
