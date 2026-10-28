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
import { up as membershipJoinDate } from '../../migrations/0040-membership-join-date';
import { up as membershipFirstSale } from '../../migrations/0042-membership-first-sale';

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
    // P18.96-T6 adds Lukman's and Tari's (`activation-3m-fixture.ts`).
    expect(first.written.activationProgress).toBe(9 + COHORT_HIRES.length + 2);
    expect(first.activation.activations.every((a) => a.templateVersion === 1 && a.items.length === 16 && a.origin === 'backfill')).toBe(true);
  });

  it('Seed: Rina, day 59 — her three links complete from her own data, ticks of hers and Sari’s, and Sari’s note', async () => {
    const rina = await mine('rina@kpm0417.test');
    const sari = await memberOf('sari@kpm0417.test');
    // P18.96-T4: ten of sixteen — her closings tick *Close first case* and the milestone, her four 1:1s the check-in.
    expect(rina).toMatchObject({ day: 59, startDate: addDays(today, -58), state: 'open', done: 11, pct: 69, overdue: false });
    for (const code of ['GOAL_SETTING', 'ADD_PROSPECTS', 'ACTIVITY_TRACKER_WEEKLY', 'FIRST_CASE_CLOSED', 'INDEPENDENT_AGENT_MILESTONE', 'WEEKLY_CHECK_IN']) {
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

    // P18.96-T4 AC-5: his first case ticks itself from his existing closing, the production file's — nine of sixteen.
    expect(await mine('dimas@kpm0417.test')).toMatchObject({ day: 95, overdue: true, done: 9, pct: 56 });
    const indah = await mine('indah@kpm0417.test');
    expect(indah).toMatchObject({ day: 98, overdue: true, done: 15, firstCaseClosed: true });
    expect(item(indah, 'INDEPENDENT_AGENT_MILESTONE').done).toBe(false);
  });

  it('P18.96-T6 Seed: Agus’s new hires in three sections — Rina in progress, Indah and Dimas activated, Lukman and Tari not', async () => {
    const roster = await wired.newHires.roster(await as('agus@kpm0417.test'));
    const rows = (section: keyof typeof roster.sections) => roster.sections[section].map((r) => `${r.hire.name} ${r.day}`);
    // Through day 90, with a first sale or not; by day, highest first.
    expect(rows('inProgress')).toEqual([
      'Wahyu Saputra 87', 'Novi Andriani 85', 'Budi Santoso 62', 'Rina Wijaya 59', 'Yanti Kusuma 29',
    ]);
    // A first sale by day 90 — Siti's checklist graduated, Dimas's and Indah's overdue: the checklist is not the result.
    expect(rows('activated')).toEqual(['Dimas Pratama 95', 'Indah Permatasari 98', 'Siti Rahmawati 102']);
    expect(rows('notActivated')).toEqual(['Tari Wulandari 41', 'Lukman Hakim 100']);
    const row = (name: string) => Object.values(roster.sections).flat().find((r) => r.hire.name === name)!;
    // Lukman's only sale was on day 96: active since, and not activated.
    expect(row('Lukman Hakim')).toMatchObject({
      activation3M: 'not_activated', leftOn: null, firstSaleDate: addDays(row('Lukman Hakim').joinDate, 95),
      unit: { kind: 'direct', leader: null }, checklist: { state: 'open', overdue: true },
    });
    // Tari left on day 35 before any sale, marked by Arief.
    expect(row('Tari Wulandari')).toMatchObject({
      activation3M: 'not_activated', leftOn: addDays(today, -6), firstSaleDate: null, unit: { kind: 'aab', leader: { name: 'Arief Hidayat' } },
    });
    expect(row('Indah Permatasari')).toMatchObject({ checklist: { state: 'open', overdue: true } });
    expect(row('Siti Rahmawati')).toMatchObject({ checklist: { state: 'graduated', pct: 100 } });
    // An existing agent never appears: Sari, Dewi and Arief lead units, and the cohort's twelve are not his.
    expect(Object.values(roster.sections).flat().map((r) => r.hire.name)).not.toEqual(expect.arrayContaining(['Sari Puspita']));
  });

  it('P18.96-T6 Seed: Agus’s 3M activation % is 3 of 5, over at least two join months, and each unit’s beside it', async () => {
    const roster = await wired.newHires.roster(await as('agus@kpm0417.test'));
    expect(roster.activation3M.all).toEqual({ activated: 3, notActivated: 2, inProgress: 5, pct: 60 });
    expect(roster.activation3M.byMonth.filter((m) => m.pct !== null).length).toBeGreaterThanOrEqual(2);
    // Direct Unit first, then the leaders A to Z.
    expect(roster.units.map((u) => [u.leader?.name ?? 'Direct Unit', u.activation3M.all.activated, u.activation3M.all.notActivated]))
      .toEqual([['Direct Unit', 3, 1], ['Arief Hidayat', 0, 1], ['Sari Puspita', 0, 0]]);
    expect(roster.units.find((u) => u.leader?.name === 'Sari Puspita')!.activation3M.all.pct).toBeNull();
    // Each month's figure is its join month's new hires.
    for (const month of roster.activation3M.byMonth) {
      const theirs = Object.values(roster.sections).flat().filter((r) => r.joinDate.startsWith(month.month));
      expect(month.activated + month.notActivated + month.inProgress).toBe(theirs.length);
    }
  });

  it('P18.96-T6 Seed: Arief reads Tari’s leaving, and its audit row; the decided results Agus’s read kept stay kept', async () => {
    const arief = await wired.newHires.roster(await as('arief@kpm0417.test'));
    expect(arief.sections.notActivated.map((r) => [r.hire.name, r.leftOn])).toEqual([['Tari Wulandari', addDays(today, -6)]]);
    const tariUser = await col('users').findOne({ email: 'tari@kpm0417.test' });
    const tari = (await col('memberships').findOne({ userId: String(tariUser!._id) }))!;
    // *Mark left* removes a new hire from the office: removed the instant she left (ADR-0169 §4 as amended).
    expect(tari).toMatchObject({ activation3M: 'not_activated', status: 'removed' });
    expect(tari.removedAt).toEqual(tari.leftAt);
    expect(await col('auditLog').countDocuments({ action: 'new_hire.marked_left', targetMembershipId: String(tari._id) })).toBe(1);
    // Agus's read above kept the five decided results on their memberships.
    for (const [email, result] of [['indah@kpm0417.test', 'activated'], ['lukman@kpm0417.test', 'not_activated']] as const) {
      expect([email, (await memberOf(email)).activation3M]).toEqual([email, result]);
    }
    expect((await memberOf('rina@kpm0417.test')).activation3M).toBeNull();
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

  /** Every membership's `[name, joinedAs, joinDate]`, by id. */
  async function classification(): Promise<Map<string, [string, unknown, unknown]>> {
    const names = new Map((await col('users').find({}).toArray()).map((u) => [String(u._id), u.fullName as string]));
    return new Map((await col('memberships').find({}).toArray()).map((m) => [
      String(m._id), [names.get(String(m.userId)) ?? '', m.joinedAs ?? null, m.joinDate ?? null],
    ]));
  }

  it('P18.96-T2 AC-2 the report’s seven are new hires, joined on their activation’s start; every other member is an existing agent', async () => {
    const seen = await classification();
    const starts = new Map((await col('activationProgress').find({ deletedAt: null }).toArray())
      .map((a) => [a.membershipId as string, a.startDate as string]));
    const nadia = String((await memberOf('agent@kpm0701.test'))._id);
    const newHires = [...seen].filter(([id, [, as]]) => as === 'new_hire' && id !== nadia);
    // Exactly the memberships the seed gave an activation, each on its start date — Wahyu's corrected one included —
    // and Nadia, placed by Hadi's code a week ago, whose office has no checklist to give her one yet (ADR-0115 §8).
    expect(new Map(newHires.map(([id, [, , date]]) => [id, date]))).toEqual(starts);
    expect(seen.get(nadia)).toEqual(['Nadia Putri', 'new_hire', addDays(today, -7)]);
    const names = newHires.map(([, [name]]) => name);
    for (const name of ['Indah Permatasari', 'Dimas Pratama', 'Wahyu Saputra', 'Novi Andriani', 'Budi Santoso', 'Rina Wijaya', 'Yanti Kusuma']) {
      expect(names).toContain(name);
    }
    const wahyu = await memberOf('wahyu@kpm0417.test');
    expect(wahyu).toMatchObject({ joinedAs: 'new_hire', joinDate: addDays(today, -86) });
    // Sari, Dewi and Arief joined as Agents and were promoted, with no activation: existing agents, as is the Owner.
    for (const email of ['sari@kpm0417.test', 'dewi@kpm0417.test', 'arief@kpm0417.test', 'owner@kpm0417.test']) {
      expect(await memberOf(email)).toMatchObject({ joinedAs: 'existing_agent' });
    }
    // Everybody else made active is an existing agent; a pending member has neither.
    const pending = new Set((await col('memberships').find({ status: 'pending' }).toArray()).map((m) => String(m._id)));
    for (const [id, [name, as, date]] of seen) {
      if (pending.has(id)) expect([name, as, date]).toEqual([name, null, null]);
      else if (as !== 'new_hire') expect([name, as, typeof date]).toEqual([name, 'existing_agent', 'string']);
    }
  });

  it('P18.96-T2 AC-2 migration 0040 finds nothing to do on the seed, and over it with the fields taken away gives the same answer, twice', async () => {
    const seeded = await classification();
    const waiting = await col('memberships').countDocuments({ status: 'pending', joinedAs: null });
    expect(await membershipJoinDate(mongoose.connection.db!)).toEqual({ newHires: 0, existingAgents: 0, waiting });

    await col('memberships').updateMany({}, { $unset: { joinedAs: '', joinDate: '' } });
    const migrated = await membershipJoinDate(mongoose.connection.db!);
    expect(migrated.newHires).toBe(await col('activationProgress').countDocuments({ deletedAt: null }));
    // The one answer the migration cannot give: Nadia's leader's code made her a new hire, and she has no activation
    // to say so — reading the records alone, she is an existing agent.
    const nadia = String((await memberOf('agent@kpm0701.test'))._id);
    expect(await classification()).toEqual(new Map([...seeded].map(([id, row]) => [id, id === nadia ? [row[0], 'existing_agent', row[2]] : row])));
    expect(await membershipJoinDate(mongoose.connection.db!)).toEqual({ newHires: 0, existingAgents: 0, waiting });
  });

  // ------------------------------------------------------------------ P18.96-T4: first sales and data-backed items

  const firstSaleOf = async (email: string) => {
    const row = await memberOf(email);
    return { date: row.firstSaleDate ?? null, source: row.firstSaleSource ?? null, joinDate: row.joinDate as string };
  };

  it('P18.96-T4 AC-5 Dimas’s Close first case independently ticks itself from his existing closing — the file’s, the same on his leader’s detail', async () => {
    const dimas = await mine('dimas@kpm0417.test');
    const lastMonthStart = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    expect(item(dimas, 'FIRST_CASE_CLOSED')).toMatchObject({
      done: true, source: 'link', waiting: false, record: { collection: 'monthlyAgentData' }, link: { kind: 'sales:first', label: 'Sales data' },
    });
    expect(await firstSaleOf('dimas@kpm0417.test')).toMatchObject({ date: lastMonthStart, source: 'monthly_file' });
    const detail = await wired.newHires.detail(await as('agus@kpm0417.test'), dimas.hire.membershipId);
    expect(item(detail, 'FIRST_CASE_CLOSED')).toMatchObject({ done: true, source: 'link', record: item(dimas, 'FIRST_CASE_CLOSED').record });
  });

  it('P18.96-T4 Seed: Novi’s first sale is on day 20, from a lead paid and issued; Raka’s only sale is on day 120', async () => {
    const novi = await firstSaleOf('novi@kpm0417.test');
    expect(novi).toMatchObject({ source: 'lead', date: addDays(novi.joinDate, 19) });
    const raka = await firstSaleOf('raka@kpm0417.test');
    expect(raka).toMatchObject({ source: 'lead', date: addDays(raka.joinDate, 119) });
    const noviView = await mine('novi@kpm0417.test');
    expect(item(noviView, 'FIRST_CASE_CLOSED')).toMatchObject({ done: true, source: 'link', record: { collection: 'leads' } });
    expect(noviView.done).toBe(10);
  });

  it('P18.96-T4 Seed: Rina’s four 1:1s complete her check-in from coaching; Indah’s, ticked by Agus, waits for data', async () => {
    expect(item(await mine('rina@kpm0417.test'), 'WEEKLY_CHECK_IN')).toMatchObject({
      done: true, source: 'link', waiting: false, record: { collection: 'coachingSessions' }, doneBy: { name: 'Sari Puspita' },
    });
    expect(item(await mine('indah@kpm0417.test'), 'WEEKLY_CHECK_IN')).toMatchObject({
      done: true, source: 'leader', waiting: true, doneBy: { name: 'Agus Prasetyo' },
    });
  });

  it('P18.96-T4 AC-1 migration 0042 finds nothing to write over the seed: the seed’s first sales are its own', async () => {
    const result = await membershipFirstSale(mongoose.connection.db!);
    expect(result.written).toBe(0);
  });
});
