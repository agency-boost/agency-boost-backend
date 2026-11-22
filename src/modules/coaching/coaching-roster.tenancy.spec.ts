import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import type { CoachingRosterView, RosterRow } from './coaching-roster.service';

const M = 1_000_000 * 100;

/** Every key the roster may carry, at any depth (P11-T6 AC-6): verdicts and dates, and no count. */
const ROSTER_KEYS = [
  'today', 'overdueAfterDays',
  'membershipId', 'name', 'rung', 'code', 'label', 'depth', 'lastOneOnOne', 'days', 'date', 'overdue', 'coach', 'status',
  // UI V1 (UI-111): each row's profile photo, a signed link or null — a picture, never a figure.
  'photoUrl',
  // P19.18-T5 (ADR-0271 §9): the view, the sections and their team lines, and per row the coaching tile, WhatsApp, the
  // reader's own row and whether it opens. *n orang* and *Semua orang · n* are counts of people on the roster, no figure.
  'scope', 'scopes', 'offered', 'default', 'total', 'sections', 'key', 'kind', 'leader', 'count', 'rows', 'teams',
  'coaching', 'phone', 'isReader', 'opens',
].sort();

/** Every key in an answer, at any depth. */
function keysOf(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keysOf(item, into));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      into.add(key);
      keysOf(value, into);
    }
  }
  return into;
}

/**
 * **The coaching roster, on real rows** (P11-T6 AC-2 to AC-6; `functional/coaching.md`, *`/coaching` — the
 * roster*, and the Data contract's `GET /coaching/coachees`). The office is `test/coaching-office.ts`'s.
 */
describe('the coaching roster (P11-T6)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
  }, 120_000);
  afterAll(stopMongo);

  const roster = (who: Who) => wired.coachingRoster.read(office.as(who));
  /** The roster as its sections draw it (P19.18-T5): each section's kind, line and rows, then its team lines'. */
  const drawn = (view: CoachingRosterView) => view.sections.map((x) => [
    x.kind, x.leader?.name ?? null, x.count, x.rows.map((r) => r.name), x.teams.map((t) => [t.leader.name, t.count, t.rows.map((r) => r.name)]),
  ]);
  const everyRow = (view: CoachingRosterView): RosterRow[] =>
    view.sections.flatMap((x) => [...x.rows, ...x.teams.flatMap((t) => t.rows)]);
  const coachees = (view: CoachingRosterView) => everyRow(view).filter((r) => !r.isReader);
  const rowOf = (view: CoachingRosterView, who: Who) => everyRow(view).find((r) => r.membershipId === office.id[who])!;

  describe('AC-2: everyone in the reader’s reach, grouped as the prototype groups it, and nobody else', () => {
    it('P19.18-T5 AC-2 an AB: Unit Anda — them, an AAB with no team, their agents — then each unit with its team lines, AB → AAB → agents', async () => {
      expect(drawn(await roster('AGUS'))).toEqual([
        ['own', 'Agus Salim', 4, ['Agus Salim', 'Dewi Lestari', 'Dimas Pratama', 'Indah Permatasari'], []],
        // A team inside a unit is a team line of the same section, never a folder (Nina's under Sari's).
        ['unit', 'Sari Puspita', 5, ['Sari Puspita', 'Budi Santoso', 'Rina Wijaya'], [['Nina Lestari', 2, ['Nina Lestari', 'Dodi Kurniawan']]]],
        // An agent who leads heads a unit rather than sitting among the agents.
        ['unit', 'Lukas Hartono', 2, ['Lukas Hartono', 'Tari Anggraini'], []],
      ]);
    });

    it('P11-T6 AC-2 depth counts the edges from the reader, and the rung is the ladder’s', async () => {
      const view = await roster('AGUS');
      const sari = view.sections[1];
      expect(sari.rows[0]).toMatchObject({ name: 'Sari Puspita', depth: 1, rung: { code: 'AAB', label: 'AAB' } });
      expect([...sari.rows.slice(1), ...sari.teams[0].rows].map((m) => [m.name, m.depth, m.rung.code])).toEqual([
        ['Budi Santoso', 2, 'AGENT'], ['Rina Wijaya', 2, 'AGENT'], ['Nina Lestari', 2, 'AAB'], ['Dodi Kurniawan', 3, 'AGENT'],
      ]);
      expect(view.sections[0].rows[2].rung).toEqual({ code: 'AGENT', label: 'Agent' });
      expect(view.sections[0].rows[0]).toMatchObject({ depth: 0, isReader: true, opens: true });
    });

    it('P11-T6 AC-2 an AAB reaches their subtree, a nested AAB’s agent included (ADR-0074)', async () => {
      expect(drawn(await roster('SARI'))).toEqual([
        ['own', 'Sari Puspita', 3, ['Sari Puspita', 'Budi Santoso', 'Rina Wijaya'], []],
        ['unit', 'Nina Lestari', 2, ['Nina Lestari', 'Dodi Kurniawan'], []],
      ]);
    });

    it('P11-T6 AC-2 a peer AAB’s agent is never listed, either way round', async () => {
      const sari = everyRow(await roster('SARI')).map((r) => r.membershipId);
      const peer = coachees(await roster('PEER_AAB')).map((r) => r.membershipId);
      expect(sari).not.toContain(office.id.PEER_AGENT);
      expect(peer).toEqual([office.id.PEER_AGENT]);
      expect(everyRow(await roster('AGUS')).map((r) => r.membershipId)).not.toContain(office.id.PEER_AGENT);
    });

    it('P19.18-T5 AC-2 the reader once, on their own row; never upward, and never a member who has left', async () => {
      const view = await roster('AGUS');
      const ids = everyRow(view).map((r) => r.membershipId);
      expect(ids.filter((id) => id === office.id.AGUS)).toHaveLength(1);
      expect(ids).not.toContain(office.id.OWNER);
      expect(ids).not.toContain(office.id.LEFT);
      expect(ids).toHaveLength(11);
      expect(view.total).toBe(11);
    });

    it('P19.18-T5 AC-1, AC-2 the Owner reads the whole office: one line per AB unit — never called AAB — its teams as team lines', async () => {
      const view = await roster('OWNER');
      expect(view).toMatchObject({ scope: 'downline', scopes: { default: 'downline' }, total: 16 });
      expect(view.sections.map((x) => [x.kind, x.leader?.name, x.count, x.teams.map((t) => t.leader.name)])).toEqual([
        ['own', 'Wilson Tanoto', 1, []],
        ['unit', 'Agus Salim', 11, ['Sari Puspita', 'Nina Lestari', 'Lukas Hartono']],
        ['unit', 'Hendra Gunawan', 3, ['Putu Ayu']],
        ['unit', 'Maya Kusuma', 1, []],
      ]);
      // An AB below the Owner carries the AB rung, never AAB.
      expect(view.sections[1].rows[0].rung.code).toBe('AB');
      expect(everyRow(view).map((r) => r.membershipId)).not.toContain(office.id.B_AGENT);
      expect(everyRow(view).every((r) => r.opens)).toBe(true);
    });

    it('P19.18-T5 AC-1 the Admin, leading nobody, reads the whole office too; who is outside her own team is listed and does not open', async () => {
      const view = await roster('ADMIN');
      expect(view.total).toBe(16);
      expect(everyRow(view).filter((r) => r.opens).map((r) => r.membershipId)).toEqual([office.id.ADMIN]);
    });

    it('P19.18-T5 AC-1 the view narrows it: Direct Unit, Grup langsung — offered as the Unit Dashboard offers them', async () => {
      const owner = await wired.coachingRoster.read(office.as('OWNER'), { scope: 'unit' });
      expect(owner).toMatchObject({ scope: 'unit', total: 1, scopes: { offered: ['unit', 'direct', 'informal', 'downline'] } });
      const agus = await wired.coachingRoster.read(office.as('AGUS'), { scope: 'unit' });
      expect(everyRow(agus).map((r) => r.name)).toEqual(['Agus Salim', 'Dewi Lestari', 'Dimas Pratama', 'Indah Permatasari']);
      // A view not offered falls back to everybody coached.
      expect((await wired.coachingRoster.read(office.as('SARI'), { scope: 'downline' })).total).toBe(5);
    });

    it('P19.18-T5 AC-2 each row carries the coaching status tile and who led the 1:1, and the WhatsApp number — none on the reader’s own', async () => {
      await mongoose.connection.db!.collection('users').updateOne({ fullName: 'Rina Wijaya' }, { $set: { phone: '+6281211110000' } });
      const view = await roster('AGUS');
      expect(rowOf(view, 'RINA')).toMatchObject({
        coaching: { status: 'recent', days: 0, coach: { membershipId: office.id.SARI, name: 'Sari Puspita' } }, phone: '+6281211110000',
      });
      expect(rowOf(view, 'AGUS').phone).toBeNull();
      for (const row of everyRow(view)) {
        const expected = row.coaching.days === null ? 'never' : row.coaching.days <= 14 ? 'recent' : 'lapsed';
        expect({ who: row.name, status: row.coaching.status }).toEqual({ who: row.name, status: expected });
      }
    });

    it('P19.18-T5 AC-2 test accounts are never on it (ADR-0267 §1)', async () => {
      await mongoose.connection.db!.collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.TARI) }, { $set: { testAccount: true } });
      try {
        expect(everyRow(await roster('OWNER')).map((r) => r.membershipId)).not.toContain(office.id.TARI);
      } finally {
        await mongoose.connection.db!.collection('memberships').updateOne({ _id: new mongoose.Types.ObjectId(office.id.TARI) }, { $set: { testAccount: false } });
      }
    });

    it('P11-T6 AC-2 somebody who coaches nobody gets an empty roster, not an error', async () => {
      for (const who of ['DEWI', 'INDAH', 'TARI'] as const) {
        expect({ who, view: await roster(who) }).toMatchObject({
          who, view: { today: ROSTER_TODAY, overdueAfterDays: 7, total: 0, sections: [] },
        });
      }
    });

    it('P11-T6 AC-2 a reader with no membership is refused by name', async () => {
      await expect(wired.coachingRoster.read(new RequestContext('u9', 'none', null)))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('AC-3: Last 1:1 is DAYS_SINCE_LAST_COACHING, and its session’s coach', () => {
    it('P11-T6 AC-3 the office’s today and its overdue threshold come with the roster', async () => {
      expect(await roster('AGUS')).toMatchObject({ today: ROSTER_TODAY, overdueAfterDays: 7 });
    });

    it('P11-T6 AC-3 today, a recent 1:1, an overdue one, and none — each with who led it', async () => {
      const view = await roster('AGUS');
      expect(rowOf(view, 'RINA').lastOneOnOne).toEqual({
        days: 0, date: ROSTER_TODAY, overdue: false, coach: { membershipId: office.id.SARI, name: 'Sari Puspita' },
      });
      expect(rowOf(view, 'INDAH').lastOneOnOne).toEqual({
        days: 4, date: '2026-09-10', overdue: false, coach: { membershipId: office.id.AGUS, name: 'Agus Salim' },
      });
      expect(rowOf(view, 'SARI').lastOneOnOne).toMatchObject({ days: 12, date: '2026-09-02', overdue: true });
      // A draft never counts: Agus has one open with Dimas, and Dimas has had no 1:1.
      expect(rowOf(view, 'DIMAS').lastOneOnOne).toBeNull();
      expect(rowOf(view, 'TARI').lastOneOnOne).toBeNull();
    });

    it('P11-T6 AC-3 a coach who can no longer be named is —, and the 1:1 still counts', async () => {
      expect(rowOf(await roster('AGUS'), 'BUDI').lastOneOnOne).toEqual({
        days: 2, date: '2026-09-12', overdue: false, coach: null,
      });
    });

    it('P11-T6 AC-3 overdue is the office’s own threshold, not the default', async () => {
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { 'settings.coachingOverdueDays': 3 } },
      );
      try {
        const view = await roster('AGUS');
        expect(view.overdueAfterDays).toBe(3);
        expect(rowOf(view, 'INDAH').lastOneOnOne?.overdue).toBe(true);
        expect(rowOf(view, 'BUDI').lastOneOnOne?.overdue).toBe(false);
      } finally {
        await mongoose.connection.db!.collection('kpms').updateOne(
          { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { 'settings.coachingOverdueDays': 7 } },
        );
      }
    });

    it('P11-T6 AC-3 is the same whoever reads it: the coachee’s latest 1:1, not the reader’s', async () => {
      expect(rowOf(await roster('SARI'), 'RINA').lastOneOnOne)
        .toEqual(rowOf(await roster('OWNER'), 'RINA').lastOneOnOne);
    });
  });

  describe('AC-4: Status is GOAL_PACE_STATUS over PACING_TO_MAA, on the calendar month', () => {
    it('P11-T6 AC-4 every one of the four states, each where the office puts it', async () => {
      const view = await roster('AGUS');
      expect(Object.fromEntries((['INDAH', 'DIMAS', 'RINA', 'SARI', 'BUDI', 'DEWI'] as const)
        .map((who) => [who, rowOf(view, who).status]))).toEqual({
        INDAH: 'on_track', DIMAS: 'watch_closely', RINA: 'needs_attention',
        SARI: 'no_goal_set', BUDI: 'no_goal_set', DEWI: 'no_goal_set',
      });
    });

    it('P11-T6 AC-4 ADR-0080: no goal is No goal set even with production on file, never Watch closely', async () => {
      // Sari's September is on file at Rp 90 M; with no target there is nothing to measure it against.
      expect(rowOf(await roster('AGUS'), 'SARI').status).toBe('no_goal_set');
    });

    it('P11-T6 AC-4 the roster’s month is the Summary’s month, for the same person', async () => {
      // One definition: the roster and the coachee's own Summary agree on this month's APE target and
      // its closing target, which the MAA projection multiplies by (ADR-0056, invariant §8).
      const paces = await wired.paceStatus.paceOf(office.as('AGUS'), [office.id.INDAH, office.id.DIMAS, office.id.RINA], {
        today: ROSTER_TODAY, month: '2026-09', onTrackRatio: 0.9,
      });
      for (const who of ['INDAH', 'DIMAS', 'RINA'] as const) {
        const summary = await wired.summary.read(office.as(who));
        expect({ who, target: paces.get(office.id[who])?.monthlyTargetMinor })
          .toEqual({ who, target: summary.monthly.targetMinor });
        expect(summary.monthly.targetMinor).toBe(85 * M);
        expect(summary.activity.monthly.targets.find((t) => t.code === 'SELL_SUBMISSION')?.target).toBe(5);
      }
    });

    it('P13.1-T5 AC-2 before the month’s file lands, the roster reads the Summary’s last 30 days (ADR-0092, ADR-0109)', async () => {
      const db = mongoose.connection.db!;
      const september = { kpmId: KPM_A, membershipId: office.id.DIMAS, month: '2026-09' };
      // Dimas paces to MAA on his presentations. His September is not filed yet, and five closings on
      // 20 August are inside the last 30 days of the 14th of September, outside the calendar month.
      await db.collection('monthlyAgentData').updateOne(september, { $set: { deletedAt: new Date() } });
      const late = await db.collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: office.id.DIMAS, localDate: '2026-08-20',
        entries: [{ activityTypeId: 't-SELL_SUBMISSION', activityTypeCode: 'SELL_SUBMISSION', count: 5 }], totalCount: 5,
        source: 'self', enteredByMembershipId: office.id.DIMAS, version: 1, frozenAt: null, corrections: [], deletedAt: null,
      } as never);
      try {
        // One number: his Summary's *tracking to close 5 … against a target of 5*, and his row On track.
        expect((await wired.summary.read(office.as('DIMAS'))).pace).toMatchObject({ closingsLast30Days: 5, closingTarget: 5 });
        expect(rowOf(await roster('AGUS'), 'DIMAS').status).toBe('on_track');

        // On 15 August they are the 31st day back: neither counts them.
        await db.collection('activityLogs').updateOne({ _id: late.insertedId }, { $set: { localDate: '2026-08-15' } });
        expect((await wired.summary.read(office.as('DIMAS'))).pace?.closingsLast30Days).toBe(0);
        expect(rowOf(await roster('AGUS'), 'DIMAS').status).toBe('watch_closely');
      } finally {
        await db.collection('monthlyAgentData').updateOne(september, { $set: { deletedAt: null } });
        await db.collection('activityLogs').deleteOne({ _id: late.insertedId });
      }
    });

    it('P11-T6 AC-4 reads the office’s own on-track ratio', async () => {
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { 'settings.onTrackPaceThreshold': 0.2 } },
      );
      try {
        expect(rowOf(await roster('AGUS'), 'DIMAS').status).toBe('on_track');
      } finally {
        await mongoose.connection.db!.collection('kpms').updateOne(
          { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { 'settings.onTrackPaceThreshold': 0.9 } },
        );
      }
    });
  });

  describe('AC-6: statuses and dates, never a row-level activity count', () => {
    it('P11-T6 AC-6 the answer carries only the contract’s keys, at every depth', async () => {
      for (const who of ['AGUS', 'SARI', 'OWNER'] as const) {
        expect({ who, keys: [...keysOf(await roster(who))].sort() }).toEqual({ who, keys: ROSTER_KEYS });
      }
    });

    it('P11-T6 AC-6 no number in it but a depth, a count of days and the threshold', async () => {
      const numbers: string[] = [];
      const walk = (node: unknown, key: string): void => {
        if (typeof node === 'number') numbers.push(key);
        else if (Array.isArray(node)) node.forEach((item) => walk(item, key));
        else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
      };
      walk(await roster('AGUS'), '');
      // P19.18-T5: and how many people a line and the roster hold — a headcount, nobody's figure.
      expect([...new Set(numbers)].sort()).toEqual(['count', 'days', 'depth', 'overdueAfterDays', 'total']);
    });
  });

  describe('the tenant boundary', () => {
    it('P11-T6 AC-2 an AB in another office reads their own office’s people and none of this one’s', async () => {
      const view = await roster('B_AB');
      expect(coachees(view).map((r) => r.name)).toEqual(['Bayu Saputra']);
      expect(everyRow(view).find((r) => r.membershipId === office.id.RINA)).toBeUndefined();
    });

    it('P11-T6 AC-2 a member of this office named in another office’s context is nobody there', async () => {
      // Agus's membership id, with office B in the context: the reach is scoped to B, and B has no Agus.
      const misplaced = new RequestContext('u-agus', 'none', {
        membershipId: office.id.AGUS, kpmId: '66f0000000000000000000b1', orgLevelCode: 'AB', hierarchyRole: 'ab',
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 6,
      } as never);
      expect(await wired.coachingRoster.read(misplaced)).toMatchObject({ total: 0, sections: [] });
    });

    it('P11-T6 AC-2 an office whose row is gone still answers its rungs, by their codes', async () => {
      const KPM_C = '66f0000000000000000000c9';
      const db = mongoose.connection.db!;
      const lead = new mongoose.Types.ObjectId();
      // Two agents, the later id first: with no name to sort them by, the roster falls back to the id.
      const [first, second] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
      // Accounts that are not there: the ids are well formed, and nobody holds them.
      const nobody = () => new mongoose.Types.ObjectId().toString();
      const agent = (id: mongoose.Types.ObjectId, seq: number) => ({
        _id: id, kpmId: KPM_C, userId: nobody(), agentCode: `C${seq}`, agentSeq: seq, leaderCode: `CAGENT${seq}`,
        orgLevelId: 'x', orgLevelCode: 'AGENT', role: 'agent', leaderId: String(lead), ancestorIds: [String(lead)],
        depth: 1, status: 'active', deletedAt: null,
      });
      await db.collection('memberships').insertMany([
        { _id: lead, kpmId: KPM_C, userId: nobody(), agentCode: 'C1', agentSeq: 1, leaderCode: 'CLEAD1', orgLevelId: 'x',
          orgLevelCode: 'AAB', role: 'aab', leaderId: null, ancestorIds: [], depth: 0, status: 'active', deletedAt: null },
        agent(second, 2), agent(first, 3),
      ]);
      const view = await wired.coachingRoster.read(new RequestContext('u-c', 'none', {
        membershipId: String(lead), kpmId: KPM_C, orgLevelCode: 'AAB', hierarchyRole: 'aab',
        status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 2,
      } as never));
      // No ladder to label them, and no account to name them: the code, and an empty name, rather than a guess.
      const unnamed = (id: mongoose.Types.ObjectId) => ({
        membershipId: String(id), name: '', photoUrl: null, rung: { code: 'AGENT', label: 'AGENT' }, depth: 1,
        lastOneOnOne: null, status: 'no_goal_set', coaching: { status: 'never', days: null, coach: null }, phone: null,
        isReader: false, opens: true,
      });
      expect(view.sections[0].rows.slice(1)).toEqual([unnamed(first), unnamed(second)]);
    });

    it('P11-T6 AC-9 reads nothing for nobody: an empty list asks no question of the month', async () => {
      expect(await wired.paceStatus.paceOf(office.as('AGUS'), [], { today: ROSTER_TODAY, month: '2026-09', onTrackRatio: 0.9 }))
        .toEqual(new Map());
    });
  });
});
