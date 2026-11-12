import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { UNIT_DASHBOARD_CORRECTION_REASON } from '@/domain/constants';
import type { UnitDashboardView, UnitGroup, UnitRow } from '@/modules/unit-dashboard/unit-dashboard.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { COACHING_LEADS } from '../coaching-cast';
import { ROSTER_PLAN } from '../coaching-fixture';

/*
 * The words the seed typed, in Bahasa Indonesia since P18.10-T7 (OD-238): Indah's lead's next step from the cast, Rina's
 * Pak Hendro's from `demo.ts`, and the coaching items from `coaching-fixture.ts`.
 */
const INDAH_NEXT = COACHING_LEADS.find((lead) => lead.name === 'Ibu Melati Kusumawardani')!.nextActionNote!;
const HENDRO_NEXT = 'Follow up soal ilustrasinya.';
import { seedDemo } from '../demo';
import {
  UNIT_DASHBOARD_BUDI_THIS_MONTH, UNIT_DASHBOARD_INDAH_LEAD, unitDashboardLeadId,
} from '../unit-dashboard-fixture';

const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

const rowsOf = (g: UnitGroup): UnitRow[] => [g.head, ...g.members, ...g.units.flatMap(rowsOf)];
const everyRow = (view: UnitDashboardView): UnitRow[] => [...view.yourUnit.rows, ...view.units.flatMap(rowsOf)];
const first = (name: string) => name.split(' ')[0];

/** The account's live membership in office 0417, as a signed-in context. */
async function as(email: string, flags: { owner?: boolean; admin?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  const direct = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: flags.admin ?? false,
    directCount: direct,
  } as never);
}

/**
 * **Phase 15 — the Unit Dashboard, seeded** (P15-T1 AC-12, P15-T3 AC-5; `unit-dashboard-fixture.ts`).
 *
 * The seed run as the command runs it, then read back through the dashboard's own service, so what is
 * asserted is what Agus, Sari and the Owner see — and exit criteria 1 and 2 hold on the seed, not only on
 * a fixture.
 */
describe('Phase 15 the Unit Dashboard seed — a run at 10:00 on 8 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-08T03:00:00Z'));
  const MONTH = '2026-10';
  let wired: ReturnType<typeof configModule>;
  let agus: RequestContext;
  let view: UnitDashboardView;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    agus = await as('agus@kpm0417.test');
    view = await wired.unitDashboard.read(agus);
  }, RUN_MS);
  afterAll(stopMongo);

  const row = (name: string, v = view) => everyRow(v).find((r) => first(r.name) === name)!;

  it('P18.5-T11 0417 has been open since January last year, so the Summary offers every month since, read whole', async () => {
    const august = await wired.summary.read(agus, undefined, { month: '2026-08' });
    expect(august).toMatchObject({
      month: '2026-08', pace: null,
      period: { firstMonth: '2025-01', thisMonth: MONTH, currentMonth: false, currentYear: true },
      activity: { monthly: { from: '2026-08-01', to: '2026-08-31' } },
    });
    expect((await wired.summary.read(agus, undefined, { year: '2025' })).month).toBe('2025-12');
    await expect(wired.summary.read(agus, undefined, { month: '2024-12' })).rejects.toMatchObject({ status: 400 });
  });

  it('P18.5-T14 AC-1 the raised benchmarks still leave a strength to see: Sari’s, and Rina’s cut by the four-card limit', async () => {
    const sari = await as('sari@kpm0417.test');
    const sariCards = (await wired.summary.read(sari, undefined, {})).insights;
    expect(sariCards.map((i) => i.rule)).toEqual(['RATIO_BELOW', 'RATIO_STRENGTH']);
    expect(sariCards[1]).toMatchObject({ facts: { code: 'LEADS_PER_ACTIVITY', benchmark: 1 } });

    // Rina: behind pace, two leads, and the ratio she is below on — four, so her strength is not shown (ADR-0060).
    const rina = await as('rina@kpm0417.test');
    expect((await wired.summary.read(rina, undefined, {})).insights.map((i) => i.rule))
      .toEqual(['BEHIND_PACE', 'LEAD_OVERDUE', 'LEAD_NEGLECTED', 'RATIO_BELOW']);
    const ratios = await wired.activityLogs.ratiosOf(rina, { membershipId: rina.membershipId!, orgLevelCode: 'AGENT' });
    expect(ratios.ratios.find((r) => r.code === 'LEADS_PER_ACTIVITY')).toMatchObject({ benchmark: 1, status: 'success' });
  });

  it('P15-T1 AC-12 Agus reads the roster the phase file draws: Your Unit · 4, then Arief’s, Dewi’s and Sari’s units', () => {
    // P18.8-T6 adds Lukman, Agus's own new hire (`activation-3m-fixture.ts`); Tari, Arief's, was marked left — removed.
    expect(view.yourUnit.rows.map((r) => first(r.name))).toEqual(['Agus', 'Dimas', 'Indah', 'Lukman', 'Siti']);
    expect(view.units.map((u) => [first(u.head.name), ...rowsOf(u).slice(1).map((r) => first(r.name))]))
      .toEqual([['Arief', 'Novi', 'Wahyu'], ['Dewi'], ['Sari', 'Budi', 'Rina', 'Yanti']]);
    expect(view.tiles.team).toMatchObject({ total: 13, direct: 5, units: 3, underUnits: 5 });
  });

  it('P15-T1 AC-12 every status shows, as the coaching fixture plans it', async () => {
    const roster = await wired.coachingRoster.read(agus);
    const coached = [...roster.directAgents, ...roster.units.flatMap((u) => [u.head, ...u.members])];
    for (const r of everyRow(view).filter((x) => !x.isReader)) {
      const key = first(r.name).toLowerCase() as keyof typeof ROSTER_PLAN;
      expect({ who: key, status: r.status, last: r.lastOneOnOne })
        .toEqual({ who: key, status: coached.find((c) => c.membershipId === r.membershipId)!.status, last: coached.find((c) => c.membershipId === r.membershipId)!.lastOneOnOne });
      // P18.8-T6's two new hires are not the coaching fixture's: their status is read, not planned.
      if (key in ROSTER_PLAN && !ROSTER_PLAN[key].monthDependent) expect({ who: key, status: r.status }).toEqual({ who: key, status: ROSTER_PLAN[key].status });
    }
    expect(new Set(everyRow(view).map((r) => r.status))).toEqual(new Set(['on_track', 'watch_closely', 'needs_attention', 'no_goal_set']));
  });

  it('P15-T3 AC-5 Budi and Yanti are not in this month’s file: Yanti’s month reads Not uploaded yet; Budi’s is Sari’s correction', () => {
    expect({ month: row('Yanti').production.monthly.valueMinor, goal: row('Yanti').goal.actualMinor }).toEqual({ month: null, goal: null });
    // P19.5-T2 (R4): Sari corrects Budi's month, not a year to date — so his month holds her figure.
    expect(row('Budi').production.monthly.valueMinor).toBe(UNIT_DASHBOARD_BUDI_THIS_MONTH);
    const sari = view.units[2];
    // *Changed 2026-10-27 (P18.8-T5, ADR-0172 §2):* 2 until then. *Changed P19.5-T2:* Budi's month is held now, so none
    // is missing; Yanti, a new hire with no first sale yet, is left out as one — counted in `newHires`.
    expect(sari.total.goal.missing).toBe(0);
    expect(sari.total.newHires).toBe(1);
  });

  /**
   * **P18.8-T5 — who counts where, on the seed** (ADR-0172; `functional/unit-dashboard.md`, *Seed*). Yanti rejoined 28
   * days ago and has sold nothing: last month's file lists her with no policy and this month's leaves her out, so her
   * live membership has no first sale. Rina and Budi are new hires whose first sales (T4's leads) are behind them; Sari
   * is an existing agent with no first sale, who counts as she always did.
   */
  it('P18.8-T5 AC-1 to AC-3 Yanti is in the team and tagged New hire; Rina and Budi are in from their first sales; Sari counts', async () => {
    const membership = async (email: string) => {
      const account = await col('users').findOne({ email });
      return (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
    };
    const yanti = await membership('removed@kpm0417.test');
    expect([yanti.joinedAs, yanti.firstSaleDate ?? null]).toEqual(['new_hire', null]);
    expect(row('Yanti')).toMatchObject({ membershipId: String(yanti._id), newHireBeforeFirstSale: true });
    const today = clock.localDateFor('Asia/Jakarta');
    for (const [who, email] of [['Rina', 'rina@kpm0417.test'], ['Budi', 'budi@kpm0417.test']] as const) {
      const m = await membership(email);
      expect({ who, joinedAs: m.joinedAs, sold: m.firstSaleDate <= today, tag: row(who).newHireBeforeFirstSale })
        .toEqual({ who, joinedAs: 'new_hire', sold: true, tag: false });
    }
    const sari = await membership('sari@kpm0417.test');
    expect([sari.joinedAs, sari.firstSaleDate ?? null, row('Sari').newHireBeforeFirstSale]).toEqual(['existing_agent', null, false]);
    // AC-1: every one of them is in the team; the tile counts the new hires it leaves out.
    expect(view.tiles.team.total).toBe(everyRow(view).length);
    expect(view.tiles.team.newHires).toBe(everyRow(view).filter((r) => r.newHireBeforeFirstSale).length);
    expect(view.tiles.team.newHires).toBeGreaterThanOrEqual(1);
  });

  it('UI-013 Yanti, on pace, is in Active Agent’s of — manpower — and never its count, nor the target', () => {
    expect(row('Yanti').pacingToMaa).toBe(true);
    const sari = view.units[2];
    const selling = rowsOf(sari).filter((r) => !r.newHireBeforeFirstSale);
    expect(selling.map((r) => first(r.name))).toEqual(['Sari', 'Budi', 'Rina']);
    expect(sari.total.potentialActive).toEqual({ count: selling.filter((r) => r.pacingToMaa === true).length, of: 4 });
    const all = everyRow(view).filter((r) => !r.newHireBeforeFirstSale);
    expect(view.tiles.potentialActive).toMatchObject({ count: all.filter((r) => r.pacingToMaa === true).length, of: everyRow(view).length });
    // The same number as *Your team*, and the Unit / AAB split adds up to it.
    expect(view.tiles.potentialActive.of).toBe(view.tiles.team.total);
    const { unit, aab } = view.tiles.potentialActive;
    expect([unit.of, aab.of]).toEqual([view.yourUnit.rows.length, view.tiles.team.total - view.yourUnit.rows.length]);
    expect(unit.count + aab.count).toBe(view.tiles.potentialActive.count);
    // Her target is out of the group's production: the paired target is the selling rows' with production held.
    const held = all.filter((r) => r.goal.actualMinor !== null);
    expect(view.tiles.directGroupProduction.targetMinor).toBe(held.reduce((s, r) => s + (r.goal.targetMinor ?? 0), 0));
  });

  it('P19.5-T2 AC-7 P15-T3 AC-5 Sari’s correction of Budi’s month, through Update production’s own function, under her name', async () => {
    const sari = await as('sari@kpm0417.test');
    const budi = row('Budi');
    const by = { membershipId: sari.membershipId, name: 'Sari Puspita' };
    expect(budi.production.monthly).toEqual({
      valueMinor: UNIT_DASHBOARD_BUDI_THIS_MONTH, provenance: 'corrected', correctedBy: by, correctedAt: clock.now().toISOString(),
    });
    // The year is the months' sum (R4), corrected because this month was — and names her.
    expect(budi.production.ytd).toMatchObject({ provenance: 'corrected', correctedBy: by });
    const stored = await col('monthlyAgentData').findOne({ membershipId: budi.membershipId, month: MONTH });
    expect(stored!.values.APE).toMatchObject({
      value: UNIT_DASHBOARD_BUDI_THIS_MONTH, provenance: 'corrected', correctedBy: sari.membershipId, reason: UNIT_DASHBOARD_CORRECTION_REASON,
    });
    expect(await col('auditLog').find({ action: 'upload.cell_corrected', 'after.surface': 'unit_dashboard' }).toArray())
      .toEqual([expect.objectContaining({
        actorMembershipId: sari.membershipId, targetMembershipId: budi.membershipId,
        after: expect.objectContaining({ month: MONTH, field: 'APE', reason: UNIT_DASHBOARD_CORRECTION_REASON }),
      })]);
    // Under This year the goal cell carries the mark, with her name.
    const year = await wired.unitDashboard.read(agus, { period: 'year' });
    expect(row('Budi', year).goal.source).toMatchObject({ provenance: 'corrected', month: MONTH, correctedBy: by });
    // And Budi's own Summary says the same.
    const summary = await wired.summary.read(await as('budi@kpm0417.test'));
    expect(summary.monthly.actualMinor).toBe(UNIT_DASHBOARD_BUDI_THIS_MONTH);
    expect(summary.yearly.source).toEqual(row('Budi', year).goal.source);
  });

  it('P15-T1 AC-12 Potential Recruits: Indah’s new candidate in Agus’s unit, Budi’s in Sari’s', async () => {
    expect(view.tiles.potentialRecruits).toEqual({ yourUnit: 1, aabs: 1, abs: 0 });
    expect(row('Indah').leadsCounts.recruitNominated).toBe(1);
    expect(row('Budi').leadsCounts.recruitNominated).toBe(1);
    expect(await col('leads').findOne({ _id: new mongoose.Types.ObjectId(unitDashboardLeadId(agus.kpmId!)) }))
      .toMatchObject({ name: UNIT_DASHBOARD_INDAH_LEAD.name, type: 'recruitment', commitments: [expect.objectContaining({ month: MONTH })] });
  });

  it('P15-T2 AC-5 OD-140, typed or from a lead: each row’s next item from the latest 1:1, overdue in office days', () => {
    // Sari's last 1:1 with Agus, twelve days ago: a typed item carried from the one before, due nine days ago.
    expect(row('Sari').followUp).toEqual({ text: 'Tinjau bersama Budi prospeknya yang terbengkalai', dueDate: '2026-09-29', overdueDays: 9 });
    // Indah's, four days ago: a lead action it froze, due two days ago — before any typed item.
    expect(row('Indah').followUp).toEqual({ text: INDAH_NEXT, dueDate: '2026-10-06', overdueDays: 2 });
    // Rina's, today: the lead actions it froze as they stood — Pak Hendro's next action, six days late.
    expect(row('Rina').followUp).toEqual({ text: HENDRO_NEXT, dueDate: '2026-10-02', overdueDays: 6 });
    // Nobody without a finalized session has one; a draft (Agus's with Indah today) is no session.
    for (const who of ['Agus', 'Dimas', 'Siti', 'Arief', 'Budi', 'Yanti']) expect({ who, f: row(who).followUp }).toEqual({ who, f: null });
  });

  it('Phase 15 exit B1 on the seed: the Admin opening Agus’s unit reads no lead’s text in any follow-up', async () => {
    const admin = await as('admin@kpm0417.test', { admin: true });
    const theirs = await wired.unitDashboard.read(admin, { for: agus.membershipId! });
    const text = JSON.stringify(theirs);
    for (const words of [INDAH_NEXT, HENDRO_NEXT]) expect([words, text.includes(words)]).toEqual([words, false]);
    // Sari's is typed, and the same; Indah's and Rina's fall back to a typed item of their own sessions.
    expect(row('Sari', theirs).followUp).toEqual(row('Sari').followUp);
    expect(row('Indah', theirs).followUp).toEqual({ text: 'Minta dua referral ke Ibu Melati saat serah terima polis', dueDate: '2026-10-07', overdueDays: 1 });
    expect(row('Rina', theirs).followUp).toEqual({ text: 'Closing ilustrasi Pak Hendro, atau tandai lead-nya gagal', dueDate: '2026-10-10', overdueDays: null });
    expect(everyRow(theirs).every((r) => !r.coached)).toBe(true);
  });

  it('exit criterion 1 on the seed: every total and tile is a sum of its rows, a percentage from the sums', async () => {
    for (const period of ['7d', 'month', 'year'] as const) {
      const v = await wired.unitDashboard.read(agus, { period });
      const groups = (g: UnitGroup): UnitGroup[] => [g, ...g.units.flatMap(groups)];
      for (const [everybody, total] of [
        [v.yourUnit.rows, v.yourUnit.total], ...v.units.flatMap(groups).map((g) => [rowsOf(g), g.total] as const),
      ] as const) {
        // The goal and *on pace* over the people who count for production (ADR-0172 §2); the leads over everybody.
        const rows = everybody.filter((r) => !r.newHireBeforeFirstSale);
        expect(total.newHires).toBe(everybody.length - rows.length);
        expect(total.leadsCounts.salesOpen).toBe(everybody.reduce((s, r) => s + r.leadsCounts.salesOpen, 0));
        const actuals = rows.map((r) => r.goal.actualMinor).filter((a): a is number => a !== null);
        // Paired (ADR-0165 §1, P18.5-T15 AC-6): a target counts only beside production held — every target when none is.
        const counted = actuals.length ? rows.filter((r) => r.goal.actualMinor !== null) : rows;
        const targets = counted.map((r) => r.goal.targetMinor).filter((a): a is number => a !== null);
        expect(total.goal.actualMinor).toBe(actuals.length ? actuals.reduce((a, b) => a + b, 0) : null);
        expect(total.goal.targetMinor).toBe(targets.length ? targets.reduce((a, b) => a + b, 0) : null);
        expect(total.goal.missing).toBe(rows.length - actuals.length);
        // UI-013: out of everybody — manpower.
        expect(total.potentialActive).toEqual({ count: rows.filter((r) => r.pacingToMaa === true).length, of: everybody.length });
      }
    }
  });

  it('exit criterion 2 on the seed: for every leader, every row is the Summary’s, the coaching roster’s and the month table’s', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const table = await wired.production.readMonth(owner, MONTH);
    for (const email of ['agus@kpm0417.test', 'sari@kpm0417.test', 'arief@kpm0417.test', 'owner@kpm0417.test']) {
      const reader = await as(email, { owner: email.startsWith('owner') });
      const [month, roster] = await Promise.all([wired.unitDashboard.read(reader), wired.coachingRoster.read(reader)]);
      const coached = [...roster.directAgents, ...roster.units.flatMap((u) => [u.head, ...u.members])];
      for (const r of everyRow(month)) {
        const summary = await wired.summary.read(owner, r.membershipId === owner.membershipId ? undefined : r.membershipId);
        /*
         * P19.1-T4 AC-12 (ADR-0195): a member's own estimate fixes their own month's target and nobody else's — so where the
         * Summary's year is an estimate (Raka, seeded), the leader's target is the office's figures' and is not compared.
         */
        const estimate = summary.yearly.production === 'estimate';
        /*
         * P19.11-T4 AC-6 (UX-12): a month the member typed over the upload is their own Summary's alone (Dewi and Raka,
         * seeded) — the leader's row reads the office's upload for the month, the month table's figure, or nothing.
         */
        const manual = summary.monthly.realised.source === 'manual';
        const office = table.rows.find((x) => x.membershipId === r.membershipId)!.values.APE;
        expect({ email, who: r.name, target: estimate ? 'their estimate' : r.goal.targetMinor, actual: r.goal.actualMinor, source: r.goal.source })
          .toEqual({
            email, who: r.name, target: estimate ? 'their estimate' : summary.monthly.targetMinor,
            actual: manual ? office.value : summary.monthly.actualMinor,
            source: !manual ? summary.monthly.source
              : office.value === null ? null : expect.objectContaining({ provenance: office.provenance, month: MONTH }),
          });
        if (!r.isReader) {
          const c = coached.find((x) => x.membershipId === r.membershipId)!;
          expect({ email, who: r.name, status: r.status, last: r.lastOneOnOne }).toEqual({ email, who: r.name, status: c.status, last: c.lastOneOnOne });
        }
        const mine = table.rows.find((x) => x.membershipId === r.membershipId)!;
        expect({ email, who: r.name, m: r.production.monthly.valueMinor, y: r.production.ytd.valueMinor })
          .toEqual({ email, who: r.name, m: mine.values.APE.value, y: mine.ytd.APE.value });
      }
    }
  }, 60_000);

  /**
   * **P19.8-T4 AC-14 — the mobile review's states, on the seed** (ADR-0229; MOB UI-177, UI-178, UI-181, UI-183): the
   * roster shows rows uploaded in each status beside rows not uploaded (which draw no pill), the *Aktivitas* table a count
   * in every category, and Dewi the empty unit.
   */
  it('P19.8-T4 AC-14 Agus’s Group: production uploaded for some, in each status, and not for others', () => {
    const uploaded = everyRow(view).filter((r) => r.production.monthly.valueMinor !== null);
    const notUploaded = everyRow(view).filter((r) => r.production.monthly.valueMinor === null);
    expect(notUploaded.map((r) => first(r.name))).toContain('Yanti');
    for (const status of ['on_track', 'watch_closely', 'needs_attention'] as const) {
      expect({ status, held: uploaded.some((r) => r.status === status) }).toEqual({ status, held: true });
    }
  });

  /*
   * **P19.9-T4 AC-1 — WhatsApp on the seed** (ADR-0235 §3): Agus's roster holds rows with a number on file, which open
   * WhatsApp straight through, beside rows with none, where an AB is offered *Isi nomor WhatsApp*; his own row carries none.
   */
  it('P19.9-T4 AC-1 Agus’s roster: numbers on file for some rows, none for others, never his own', () => {
    const phones = Object.fromEntries(everyRow(view).map((r) => [first(r.name), r.phone]));
    expect(phones).toMatchObject({ Indah: '+6281211002201', Siti: '+6281311002203', Arief: '+6281511002204', Dimas: null });
    expect(phones.Agus).toBeNull();
    // Every unit's header has its *Rp x / y* to show (R7): a target, and production for some of its rows.
    for (const group of view.units) expect({ unit: group.head.name, target: group.total.goal.targetMinor! > 0 }).toEqual({ unit: group.head.name, target: true });
  });

  it('P19.8-T4 AC-14 the Aktivitas table holds a count in every category for the Group, each type with its short name', async () => {
    const table = await wired.unitActivities.read(agus, { span: 'month' });
    const counted = new Set(table.totals.group.counts.map((c) => c.code));
    for (const section of table.sections) {
      expect({ section: section.code, counted: section.types.some((t) => counted.has(t.code)) })
        .toEqual({ section: section.code, counted: true });
      for (const type of section.types) expect({ type: type.code, short: typeof type.shortLabel }).toEqual({ type: type.code, short: 'string' });
    }
  });

  it('P19.8-T4 AC-14 Dewi, an AAB with no team: the empty unit on Overview and on Aktivitas', async () => {
    const dewi = await as('dewi@kpm0417.test');
    expect((await wired.unitDashboard.read(dewi)).empty).toBe(true);
    expect(await wired.unitActivities.read(dewi)).toMatchObject({ empty: true, people: [] });
  });

  it('P15-T1 AC-12 Dewi and Rina lead nobody: the empty unit; Sari and Arief their own units only', async () => {
    for (const email of ['dewi@kpm0417.test', 'rina@kpm0417.test']) {
      expect((await wired.unitDashboard.read(await as(email))).empty).toBe(true);
    }
    expect(everyRow(await wired.unitDashboard.read(await as('sari@kpm0417.test'))).map((r) => first(r.name)))
      .toEqual(['Sari', 'Budi', 'Rina', 'Yanti']);
    expect(everyRow(await wired.unitDashboard.read(await as('arief@kpm0417.test'))).map((r) => first(r.name)))
      .toEqual(['Arief', 'Novi', 'Wahyu']);
  });

  /*
   * P19.12-T6 (ADR-0249; `unit-views-fixture.ts`): Wilson's reports are all ABs, and he owns *Top Producers 2026* with
   * Agus in it — so each view reads differently on the seed, and the informal line names the ABs not yet tagged.
   */
  it('P19.12-T6 AC-2 Wilson opens on Semua downline; Grup informal brings Agus’s group and names the ABs not in it', async () => {
    const wilson = await as('owner@kpm0417.test', { owner: true });
    const office = await wired.unitDashboard.read(wilson);
    expect(office).toMatchObject({ scope: 'downline', scopes: { offered: ['direct', 'informal', 'downline'], default: 'downline' } });
    expect(office.tiles.team.direct).toBe(1);
    expect(office.tiles.team.ab).toBe(office.tiles.team.total - 1);
    const informal = await wired.unitDashboard.read(wilson, { scope: 'informal' });
    expect(informal.informal?.groups.map((g) => g.name)).toEqual(['Top Producers 2026']);
    expect(informal.informal?.abs?.map((p) => first(p.name)).sort()).toEqual(['Maya', 'Satria', 'Yosef']);
    expect(informal.informal?.absNotInGroup).toBe(3);
    expect(everyRow(informal).map((r) => first(r.name))).toEqual(expect.arrayContaining(['Wilson', 'Agus', 'Sari', 'Arief']));
    expect(everyRow(informal).length).toBeLessThan(everyRow(office).length);
    expect(await wired.unitDashboard.read(wilson, { scope: 'direct' })).toMatchObject({ scope: 'direct', empty: true });
  });

  it('P19.12-T6 AC-2 Agus, no AB below him, is offered Grup langsung alone — the picker hidden — and reads as before', async () => {
    expect(view).toMatchObject({ scope: 'direct', scopes: { offered: ['direct'], default: 'direct' }, informal: null, unled: null });
    expect(view.tiles.team.ab).toBe(0);
  });

  it('P15-T1 AC-12 a re-seed without --reset writes nothing more: the lead by its id, the correction by its marker', async () => {
    const before = await Promise.all(['leads', 'auditLog', 'monthlyAgentData', 'productionMonths'].map((name) => col(name).find({}).sort({ _id: 1 }).toArray()));
    const again = await seedDemo({ clock, log: quiet });
    expect(again.written).toEqual({});
    const after = await Promise.all(['leads', 'auditLog', 'monthlyAgentData', 'productionMonths'].map((name) => col(name).find({}).sort({ _id: 1 }).toArray()));
    expect(after.map((rows) => rows.length)).toEqual(before.map((rows) => rows.length));
    expect(after[3]).toEqual(before[3]);
  }, RUN_MS);
});
