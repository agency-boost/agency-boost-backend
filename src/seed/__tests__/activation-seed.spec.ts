import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import type { ActivationView } from '@/modules/activation/activation-progress.view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { SARI_NOTE_TO_RINA } from '../activation-fixture';
import { COHORT_HIRES } from '../cohort-fixture';
import { seedDemo, type SeedResult } from '../demo';

/**
 * **The activation demo** (Phase 13, *Seed*; `activation-fixture.ts`), run as the command runs it and read
 * back through the activation's own services — so what is asserted is what each account sees on
 * `/activation` and `/new-hires`, not what a row holds.
 *
 * Run on two dates: 03:00 on a Monday in Jakarta, while it is still Sunday in UTC — the day the office's
 * zone and the server's disagree — and 10:00 on a Friday.
 */
const RUN_MS = 240_000;
const TZ = 'Asia/Jakarta';
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function memberOf(email: string) {
  const account = await col('users').findOne({ email });
  return (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
}

async function as(email: string): Promise<RequestContext> {
  const member = await memberOf(email);
  const directs = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: directs,
  } as never);
}

const item = (view: ActivationView, code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;

describe.each([
  ['03:00 on Monday 5 October 2026 in Jakarta, still Sunday in UTC', '2026-10-04T20:00:00Z'],
  ['10:00 on Friday 2 October 2026 in Jakarta', '2026-10-02T03:00:00Z'],
])('the activation seed, run at %s', (_when, instant) => {
  const clock = new FixedClock(new Date(instant));
  const today = clock.localDateFor(TZ);
  let first: SeedResult;
  let wired: ReturnType<typeof configModule>;
  const mine = async (email: string) => wired.activationProgress.mine(await as(email));

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    first = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
  }, RUN_MS);
  afterAll(stopMongo);

  it('Seed: nine activations, dated from the office’s today, each pinned to its office’s published checklist', async () => {
    expect(first.activation.today).toBe(today);
    // Phase 18.1's cohort adds the twelve graduated long ago, written beside these nine (`cohort-fixture.ts`).
    expect(first.written.activationProgress).toBe(9 + COHORT_HIRES.length);
    expect(first.activation.activations.every((a) => a.templateVersion === 1 && a.items.length === 16 && a.origin === 'backfill')).toBe(true);
  });

  it('Seed: Rina, day 59 — her three links complete from her own data, ticks of hers and Sari’s, and Sari’s note', async () => {
    const rina = await mine('rina@kpm0417.test');
    const sari = await memberOf('sari@kpm0417.test');
    expect(rina).toMatchObject({ day: 59, startDate: addDays(today, -58), state: 'open', done: 8, pct: 50, overdue: false });
    for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY']) {
      expect([code, item(rina, code).done, item(rina, code).source]).toEqual([code, true, 'link']);
    }
    expect(item(rina, 'INSURANCE_BASICS')).toMatchObject({ source: 'hire', note: 'Read the starter pack with Sari in my first week.', date: addDays(today, -56) });
    expect(item(rina, 'ROLE_PLAY')).toMatchObject({ source: 'leader', doneBy: { membershipId: String(sari._id), name: 'Sari Puspita' } });
    expect(rina.note).toMatchObject({ text: SARI_NOTE_TO_RINA, by: { name: 'Sari Puspita' } });
  });

  it('Seed: Novi’s goal item is Arief’s; Wahyu’s start date is Arief’s correction, audited', async () => {
    const novi = await mine('novi@kpm0417.test');
    expect(item(novi, 'GOAL_SETTING')).toMatchObject({ done: true, source: 'link', doneBy: { name: 'Arief Hidayat' } });
    expect(novi).toMatchObject({ day: 85 });

    const wahyu = await mine('wahyu@kpm0417.test');
    expect(wahyu).toMatchObject({ day: 87, startDate: addDays(today, -86), startCorrected: { by: { name: 'Arief Hidayat' } } });
    const audit = await col('auditLog').findOne({ action: 'activation.start_date_corrected' });
    expect(audit).toMatchObject({ before: { startDate: addDays(today, -79) }, after: { startDate: addDays(today, -86) }, onBehalfOf: true });
  });

  it('Seed: Siti graduated, with who, when and the audit row; Dimas and Indah are overdue', async () => {
    const siti = await mine('siti@kpm0417.test');
    expect(siti).toMatchObject({ state: 'graduated', pct: 100, day: 102, graduatedBy: { name: 'Siti Rahmawati' } });
    expect(await col('auditLog').countDocuments({ action: 'activation.graduated', targetMembershipId: siti.hire.membershipId })).toBe(1);

    expect(await mine('dimas@kpm0417.test')).toMatchObject({ day: 95, overdue: true, done: 8, pct: 50 });
    const indah = await mine('indah@kpm0417.test');
    expect(indah).toMatchObject({ day: 98, overdue: true, done: 15, firstCaseClosed: true });
    expect(item(indah, 'INDEPENDENT_AGENT_MILESTONE').done).toBe(false);
  });

  it('Seed: Agus’s roster — Direct Unit, then Arief’s and Sari’s cards, A to Z; Siti gone, Dewi no card', async () => {
    const roster = await wired.newHires.roster(await as('agus@kpm0417.test'));
    expect(roster.groups.map((g) => [g.kind, g.leader?.name ?? null, g.hires.map((h) => `${h.hire.name} ${h.day}`)])).toEqual([
      ['direct', null, ['Indah Permatasari 98', 'Dimas Pratama 95']],
      // The Phase 13 exit review: by the leader's full name, A to Z — not COACH's order, which put Sari first.
      ['aab', 'Arief Hidayat', ['Wahyu Saputra 87', 'Novi Andriani 85']],
      ['aab', 'Sari Puspita', ['Budi Santoso 62', 'Rina Wijaya 59', 'Yanti Kusuma 29']],
    ]);
  });

  it('Seed: Yanti’s second membership starts afresh and her first has none; Sari, Dewi and Arief have none; Lina is day 61 in office 0555', async () => {
    expect(await mine('removed@kpm0417.test')).toMatchObject({ day: 29, startDate: addDays(today, -28) });
    const account = await col('users').findOne({ email: 'removed@kpm0417.test' });
    const former = await col('memberships').findOne({ userId: String(account!._id), status: 'removed' });
    expect(await col('activationProgress').countDocuments({ membershipId: String(former!._id) })).toBe(0);
    for (const email of ['sari@kpm0417.test', 'dewi@kpm0417.test', 'arief@kpm0417.test']) {
      await expect(mine(email)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const lina = await mine('agent@kpm0555.test');
    // Lina joined two months ago, and her activation starts on her join, as every hire's does (the Phase 18 exit review).
    expect(lina).toMatchObject({ day: 61, startDate: addDays(today, -60), state: 'open' });
    expect(item(lina, 'ADD_PROSPECTS').done).toBe(true);
  });

  it('Seed: a second run on the same day writes nothing', async () => {
    const second = await seedDemo({ clock, log: quiet });
    expect(second.written).toEqual({});
    expect(second.activation.activations.map((a) => a._id)).toEqual(first.activation.activations.map((a) => a._id));
  }, RUN_MS);
});
