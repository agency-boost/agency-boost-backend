import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, ROSTER_TODAY, type CoachingOffice, type Who,
} from '../../../test/coaching-office';
import { HomeService, type HomeView } from './home.service';

/**
 * **Home's read on real rows** (UI V1, Phase 18.11 T11; UI-100, UI-101; `functional/home.md`): office 0417 (KPM A) beside
 * 0555 (KPM B), the coaching roster's office (`test/coaching-office.ts`) — *today* is Monday 14 September 2026, 10:00 in
 * Jakarta. Every figure is held against the screen it must equal: the Unit Dashboard's tile, the Calendar's today, the
 * activity log's saved totals.
 *
 * ```
 * AGUS (AB) ─┬── INDAH, DIMAS                 his Unit (with him)
 *            ├── DEWI (AAB, nobody)
 *            ├── LUKAS ── TARI
 *            └── SARI (AAB) ─┬── RINA, BUDI   RINA logs every day; coached today by Sari, an item due today
 *                            └── NINA ── DODI
 * ```
 */
describe('GET /home, on real rows (Phase 18.11 T11)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  let home: HomeService;
  const db = () => mongoose.connection.db!;
  const clock = () => wired.clock as FixedClock;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await clearCollections();
    office = await buildCoachingOffice(wired);
    home = new HomeService(
      new TenantDay(wired.kpms as never, wired.clock),
      wired.unitDashboard,
      wired.paceStatus,
      wired.coachingReadings,
      wired.activityReadings,
      wired.memberships,
      new LeadRepository(mongoose.model(Lead.name, LeadSchema) as never),
      wired.leadReadings,
      wired.calendar,
      wired.subjectReads,
      // UI-111: a stored photo is a key, signed into a link per read; here a link the test can read.
      { linksFor: async (keys: (string | null | undefined)[]) =>
        new Map(keys.filter((k): k is string => !!k).map((k) => [k, `https://signed.test/${k}`])) } as never,
      wired.clock,
      wired.users as never,
    );

    // Indah's day: a lead whose next action is today, a meeting at 15:00 today, one tomorrow, one declined.
    const entry = (who: Who, title: string, startsAt: string, endsAt: string, over: Record<string, unknown> = {}) => ({
      kpmId: KPM_A, organiserMembershipId: office.id[who], type: 'meeting', title, notes: '',
      startsAt: new Date(startsAt), endsAt: new Date(endsAt), startsOn: null, endsOn: null, allDay: false,
      attendees: [], version: 1, deletedAt: null, ...over,
    });
    await db().collection('calendarEvents').insertMany([
      entry('INDAH', 'Weekly unit huddle', '2026-09-14T08:00:00Z', '2026-09-14T09:00:00Z'),
      entry('INDAH', 'Client review', '2026-09-15T02:00:00Z', '2026-09-15T03:00:00Z', { type: 'client' }),
      // Already over at 10:00: counted in today's meetings, not among what is next.
      entry('INDAH', 'Early stand-up', '2026-09-14T01:00:00Z', '2026-09-14T01:30:00Z'),
      // A trip is a line on the day, never a meeting.
      entry('INDAH', 'Surabaya', '2026-09-13T17:00:00Z', '2026-09-15T17:00:00Z', {
        type: 'travel', allDay: true, startsOn: '2026-09-14', endsOn: '2026-09-15',
      }),
      // Another office's entry under Indah's id: never hers.
      entry('INDAH', 'Office B meeting', '2026-09-14T06:00:00Z', '2026-09-14T07:00:00Z', { kpmId: KPM_B }),
    ]);
    const lead = (who: Who, name: string, over: Record<string, unknown> = {}) => ({
      kpmId: KPM_A, ownerMembershipId: office.id[who], type: 'sales', name, statusCode: null, outcome: null,
      commitments: [], nextActionDate: ROSTER_TODAY, nextActionNote: 'Invite BOP', version: 4, deletedAt: null,
      dateRegistered: new Date('2026-08-01T02:00:00Z'), contact: { phone: '+6281211002200', email: 'wiwik@example.test' },
      transitions: [], ...over,
    });
    await db().collection('leads').insertMany([
      lead('INDAH', 'Ibu Wiwik Setyaningsih'),
      // Tomorrow's, a closed one and a deleted one are not today's work.
      lead('INDAH', 'Pak Teddy', { nextActionDate: '2026-09-15' }),
      lead('INDAH', 'Ibu Closed', { outcome: 'won' }),
      lead('INDAH', 'Ibu Deleted', { deletedAt: new Date('2026-09-01T00:00:00Z') }),
      lead('INDAH', 'Office B lead', { kpmId: KPM_B }),
    ]);
  }, 120_000);
  afterAll(stopMongo);

  const read = (who: Who): Promise<HomeView> => home.read(office.as(who));
  const team = (view: HomeView) => view.leader!.team.map((p) => office.name[whoOf(p.membershipId)]);
  const whoOf = (id: string) => (Object.keys(office.id) as Who[]).find((w) => office.id[w] === id)!;

  describe('UI-100 the leader’s tiles', () => {
    it('UI-100 Active Agent shows exactly the Unit Dashboard tile: its figure, its manpower and its Unit / AAB split', async () => {
      const [view, dashboard] = await Promise.all([read('AGUS'), wired.unitDashboard.read(office.as('AGUS'))]);
      expect(view.leader!.activeAgent).toEqual(dashboard.tiles.potentialActive);
      // Manpower: everybody in the Group, Agus included (UI-013).
      expect(view.leader!.activeAgent.of).toBe(dashboard.tiles.team.total);
      expect(view.month).toBe(dashboard.month);
    });

    it('UI-100 the same at every period the dashboard shows, and for an AAB’s own unit', async () => {
      const dashboard = await wired.unitDashboard.read(office.as('AGUS'), { period: 'year' });
      expect((await read('AGUS')).leader!.activeAgent).toEqual(dashboard.tiles.potentialActive);
      const sari = await wired.unitDashboard.read(office.as('SARI'));
      expect((await read('SARI')).leader!.activeAgent).toEqual(sari.tiles.potentialActive);
    });

    it('UI-100 Coaching 7 hari counts members coached in the last 7 days over the same manpower, split Unit / AAB', async () => {
      const view = await read('AGUS');
      // Indah (4 days ago) in his Unit of three; Rina (today) and Budi (2 days ago, by a coach since gone) of the
      // AAB side's eight. Sari's 1:1 was twelve days ago; Dimas's is a draft, which never counts.
      expect(view.leader!.coached7d).toEqual({ count: 3, of: 11, unit: { count: 1, of: 3 }, aab: { count: 2, of: 8 } });
      expect(view.leader!.coached7d.of).toBe(view.leader!.activeAgent.of);
    });
  });

  describe('UI-101 Laporan tim', () => {
    it('UI-101 lists everybody in the Group but the reader, empty both days first, then empty today, then the rest', async () => {
      const view = await read('AGUS');
      expect(team(view)).toEqual([
        'Dimas Pratama', 'Indah Permatasari', 'Dewi Lestari', 'Lukas Hartono', 'Tari Anggraini', 'Sari Puspita',
        'Budi Santoso', 'Nina Lestari', 'Dodi Kurniawan', 'Rina Wijaya',
      ]);
      expect(view.leader!.team.some((p) => p.membershipId === office.id.AGUS)).toBe(false);
      expect(view.leader!.team.filter((p) => p.inUnit).map((p) => whoOf(p.membershipId))).toEqual(['DIMAS', 'INDAH']);
    });

    it('L7 an AAB reads Laporan tim of their own unit only: a peer AAB’s and the AB’s other units’ agents are absent', async () => {
      const view = await read('SARI');
      expect([...team(view)].sort()).toEqual(['Budi Santoso', 'Dodi Kurniawan', 'Nina Lestari', 'Rina Wijaya']);
      const listed = new Set(view.leader!.team.map((p) => p.membershipId));
      for (const who of ['AGUS', 'INDAH', 'DIMAS', 'DEWI', 'LUKAS', 'TARI', 'PEER_AAB', 'PEER_AGENT', 'SARI'] as Who[]) {
        expect({ who, listed: listed.has(office.id[who]) }).toEqual({ who, listed: false });
      }
    });

    it('UI-101 counts match Activity Management per person per day, on the office’s calendar', async () => {
      const view = await read('AGUS');
      const counts = await wired.activityReadings.perPersonPerDay(
        office.as('AGUS'), view.leader!.team.map((p) => p.membershipId), ['2026-09-13', ROSTER_TODAY],
      );
      for (const person of view.leader!.team) {
        expect({ who: person.name, yesterday: person.yesterday, today: person.today }).toEqual({
          who: person.name,
          yesterday: counts.get(person.membershipId)?.get('2026-09-13') ?? null,
          today: counts.get(person.membershipId)?.get(ROSTER_TODAY) ?? null,
        });
      }
      const rina = view.leader!.team.find((p) => p.membershipId === office.id.RINA)!;
      expect([rina.yesterday, rina.today]).toEqual([54, 54]);
    });

    it('UI-101 carries each person’s WhatsApp number and a signed photo link, never the stored key', async () => {
      await db().collection('users').updateOne({ fullName: 'Dimas Pratama' }, { $set: { phone: '+6281299990000', avatarUrl: 'user/x/avatar/1.jpg' } });
      const dimas = (await read('AGUS')).leader!.team.find((p) => p.membershipId === office.id.DIMAS)!;
      expect(dimas.phone).toBe('+6281299990000');
      expect(dimas.photoUrl).toBe('https://signed.test/user/x/avatar/1.jpg');
      const indah = (await read('AGUS')).leader!.team.find((p) => p.membershipId === office.id.INDAH)!;
      expect([indah.phone, indah.photoUrl]).toEqual([null, null]);
    });

    it('UI-101 records each person on the list as read, surface home, over yesterday and today — and nobody for an agent', async () => {
      const entries = () => db().collection('auditLog').countDocuments({ 'after.surface': 'home' });
      const before = await entries();
      await read('AGUS');
      expect(await entries()).toBe(before + 10);
      const one = await db().collection('auditLog').findOne({ 'after.surface': 'home', targetMembershipId: office.id.RINA });
      expect(one?.after).toEqual({ surface: 'home', from: '2026-09-13', to: ROSTER_TODAY });
      await read('INDAH');
      expect(await entries()).toBe(before + 10);
    });

    it('UI-101 “today” turns at the office’s midnight: at 00:30 in Jakarta Rina’s 54 is yesterday’s', async () => {
      clock().set(new Date('2026-09-14T17:30:00Z'));
      try {
        const view = await read('AGUS');
        expect(view.today).toBe('2026-09-15');
        const rina = view.leader!.team.find((p) => p.membershipId === office.id.RINA)!;
        expect([rina.yesterday, rina.today]).toEqual([54, null]);
        // Reported yesterday, not today: before the rest, after nobody — and nobody else reported either day.
        expect(team(view).at(-1)).toBe('Rina Wijaya');
      } finally {
        clock().set(ROSTER_NOW);
      }
    });
  });

  /*
   * **Tim saya, by role** (ADR-0189 §4, P19-T4 AC-2; UI-159 item 2): every leader gets the block, a leader with nobody
   * yet at zero — an AAB who leads nobody was an agent here until Phase 19.
   */
  describe('P19-T4 Tim saya for every leader', () => {
    /** Every row the Unit Dashboard draws: the reader's unit, and each unit below, its head and its members. */
    const rowsOf = (units: { head: { membershipId: string; leadsCounts: { recruitOpen: number } }; members: { membershipId: string; leadsCounts: { recruitOpen: number } }[]; units: unknown[] }[]): { membershipId: string; leadsCounts: { recruitOpen: number } }[] =>
      units.flatMap((u) => [u.head, ...u.members, ...rowsOf(u.units as never)]);

    it('P19-T4 AC-2 an AAB who leads nobody gets the leader block at zero, not null, and nobody is recorded as read', async () => {
      const before = await db().collection('auditLog').countDocuments({ 'after.surface': 'home' });
      const view = await read('DEWI');
      const zero = { count: 0, of: 0 };
      expect(view.leader).toEqual({
        activeAgent: { ...zero, unit: zero, aab: zero },
        coached7d: { ...zero, unit: zero, aab: zero },
        team: [],
        members: 0,
        recruitmentPipeline: 0,
        newHires: 0,
      });
      expect(await db().collection('auditLog').countDocuments({ 'after.surface': 'home' })).toBe(before);
    });

    it('P19-T4 AC-2 a leader with no team counts their own recruitment pipeline — never another office’s lead', async () => {
      const recruit = (kpmId: string, name: string, over: Record<string, unknown> = {}) => ({
        kpmId, ownerMembershipId: office.id.DEWI, type: 'recruitment', name, statusCode: null, outcome: null,
        commitments: [], nextActionDate: null, nextActionNote: null, version: 1, deletedAt: null,
        dateRegistered: new Date('2026-09-01T02:00:00Z'), contact: { phone: null, email: null }, transitions: [], ...over,
      });
      const { insertedIds } = await db().collection('leads').insertMany([
        recruit(KPM_A, 'Calon satu'),
        // Closed, deleted, or in KPM B under the same id: none of them is DEWI's pipeline.
        recruit(KPM_A, 'Calon dua', { outcome: 'lost' }),
        recruit(KPM_A, 'Calon tiga', { deletedAt: new Date('2026-09-02T02:00:00Z') }),
        recruit(KPM_B, 'Calon kantor B'),
      ]);
      try {
        expect((await read('DEWI')).leader!.recruitmentPipeline).toBe(1);
      } finally {
        await db().collection('leads').deleteMany({ _id: { $in: Object.values(insertedIds) } });
      }
    });

    it('P19-T4 AC-2 with a team, Anggota tim is Laporan tim’s people and New hires the Unit Dashboard’s count', async () => {
      const [view, dashboard] = await Promise.all([read('AGUS'), wired.unitDashboard.read(office.as('AGUS'))]);
      expect(view.leader!.members).toBe(view.leader!.team.length);
      expect(view.leader!.members).toBe(dashboard.tiles.team.total - 1);
      expect(view.leader!.newHires).toBe(dashboard.tiles.team.newHires);
      // The Unit Dashboard's Leads column's recruitment count, summed over every row it draws.
      const rows = [...dashboard.yourUnit.rows, ...rowsOf(dashboard.units as never)];
      expect(view.leader!.recruitmentPipeline).toBe(rows.reduce((n, row) => n + row.leadsCounts.recruitOpen, 0));
    });
  });

  describe('UI-100 the reader’s own blocks', () => {
    it('UI-100 an agent sees no leader tiles and no Laporan tim', async () => {
      expect((await read('INDAH')).leader).toBeNull();
      expect((await read('RINA')).leader).toBeNull();
    });

    it('UI-100 Aktivitas saya and the chart are the seven office days ending today, from the saved totals', async () => {
      const rina = await read('RINA');
      expect(rina.activity.days.map((d) => d.date)).toEqual([
        '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', ROSTER_TODAY,
      ]);
      expect(rina.activity.days.map((d) => d.count)).toEqual([54, 54, 54, 54, 54, 54, 54]);
      expect([rina.activity.today, rina.activity.yesterday, rina.activity.total]).toEqual([54, 54, 378]);

      // Indah logged to the 10th: three days, then four of nothing — 0 today, so the tile offers + Log.
      const indah = await read('INDAH');
      expect(indah.activity.days.map((d) => d.count)).toEqual([39, 39, 39, 0, 0, 0, 0]);
      expect(indah.activity.today).toBe(0);
    });

    it('UI-100 Jadwal hari ini is Calendar’s count of today: timed items (no trip, not another office’s) and open Tugas', async () => {
      const [view, calendar] = await Promise.all([read('INDAH'), wired.calendar.today(office.as('INDAH'))]);
      expect(view.schedule).toEqual({ meetings: calendar.meetings, tasks: calendar.tasks });
      expect(view.schedule).toEqual({ meetings: 2, tasks: 1 });
    });

    it('UI-100 Aksi hari ini: today’s Tugas first, then today’s next timed item, then the next day’s — three at most', async () => {
      const view = await read('INDAH');
      expect(view.actions).toEqual([
        {
          kind: 'lead', leadId: expect.any(String), name: 'Ibu Wiwik Setyaningsih', type: 'sales', note: 'Invite BOP',
          contact: { phone: '+6281211002200', email: 'wiwik@example.test' }, version: 4,
        },
        {
          kind: 'agenda', source: 'entry', id: expect.any(String), type: 'meeting', title: 'Weekly unit huddle',
          date: ROSTER_TODAY, start: '15:00',
        },
        {
          kind: 'agenda', source: 'entry', id: expect.any(String), type: 'client', title: 'Client review',
          date: '2026-09-15', start: '09:00',
        },
      ]);
    });

    it('UI-100 a coaching action item due today is a Tugas from the leader who coached them, with their number', async () => {
      await db().collection('users').updateOne({ fullName: 'Sari Puspita' }, { $set: { phone: '+6281277778888' } });
      const view = await read('RINA');
      expect(view.schedule.tasks).toBe(1);
      expect(view.actions[0]).toEqual({
        kind: 'coaching', sessionId: expect.any(String), itemId: 'RINA-1', text: 'Book two presentations',
        from: { membershipId: office.id.SARI, name: 'Sari Puspita', phone: '+6281277778888' },
      });
    });

    it('L1 a coach who has left keeps their name on the item and serves no number', async () => {
      const sari = new mongoose.Types.ObjectId(office.id.SARI);
      await db().collection('users').updateOne({ fullName: 'Sari Puspita' }, { $set: { phone: '+6281277778888' } });
      await db().collection('memberships').updateOne({ _id: sari }, { $set: { status: 'removed' } });
      try {
        const view = await read('RINA');
        expect(view.actions[0]).toEqual({
          kind: 'coaching', sessionId: expect.any(String), itemId: 'RINA-1', text: 'Book two presentations',
          from: { membershipId: office.id.SARI, name: 'Sari Puspita', phone: null },
        });
        expect(JSON.stringify(view)).not.toContain('81277778888');
      } finally {
        await db().collection('memberships').updateOne({ _id: sari }, { $set: { status: 'active' } });
      }
    });

    it('UI-100 still short after today: an event they joined on a later day fills a row, another office’s never', async () => {
      const event = (kpmId: string, title: string, startsAt: string, endsAt: string) => {
        const _id = new mongoose.Types.ObjectId();
        return {
          _id, kpmId, code: `EV-${_id.toString().slice(-6)}`, typeCode: 'BOP', title, blurb: '', description: '',
          startsAt: new Date(startsAt), endsAt: new Date(endsAt), location: 'Kantor KPM', locationUrl: null,
          audience: { issuer: 'kpm', scope: 'all' }, version: 1, status: 'active', archivedAt: null, deletedAt: null,
        };
      };
      const going = event(KPM_A, 'BOP Surabaya', '2026-09-16T02:00:00Z', '2026-09-16T04:00:00Z');
      const elsewhere = event(KPM_B, 'Office B BOP', '2026-09-15T02:00:00Z', '2026-09-15T04:00:00Z');
      await db().collection('eventTypes').insertOne({
        kpmId: KPM_A, code: 'BOP', label: 'Business Opportunity Presentation', displayOrder: 1, version: 1, status: 'active',
        deletedAt: null,
      });
      await db().collection('events').insertMany([going, elsewhere]);
      await db().collection('eventRsvps').insertMany([going, elsewhere].map((e) => ({
        kpmId: e.kpmId, eventId: String(e._id), membershipId: office.id.DODI, rsvpStatus: 'going', rsvpAt: null,
        cancelledAt: null, claimedAt: null, confirmedAttended: null, deletedAt: null,
      })));
      try {
        expect((await read('DODI')).actions).toEqual([{
          kind: 'agenda', source: 'event', id: String(going._id), type: 'Business Opportunity Presentation',
          title: 'BOP Surabaya', date: '2026-09-16', start: '09:00',
        }]);
      } finally {
        await db().collection('eventRsvps').deleteMany({ membershipId: office.id.DODI });
        await db().collection('events').deleteMany({ _id: { $in: [going._id, elsewhere._id] } });
        await db().collection('eventTypes').deleteMany({ code: 'BOP' });
      }
    });

    it('UI-100 nothing to do and nothing ahead: no rows', async () => {
      expect((await read('DODI')).actions).toEqual([]);
    });

    it('UI-100 the quote and the pose of the day are the office day’s', async () => {
      // 14 September 2026 is day 20710: quote #11 (index 10), pose 20710 mod 4 = 2, *pointing*.
      expect((await read('INDAH')).quote).toEqual({
        index: 10, person: 'Thomas Edison', pose: 'pointing',
        text: 'Genius is one percent inspiration and ninety-nine percent perspiration.',
      });
      expect((await read('INDAH')).now.minute).toBe(10 * 60);
    });
  });

  describe('cross-tenant', () => {
    it('another office’s rows filed under this office’s ids reach nobody here', async () => {
      await db().collection('activityLogs').insertOne({
        kpmId: KPM_B, membershipId: office.id.AGUS, localDate: ROSTER_TODAY, entries: [], totalCount: 99,
        source: 'self', enteredByMembershipId: office.id.AGUS, version: 1, frozenAt: null, corrections: [], deletedAt: null,
      });
      const agus = await read('AGUS');
      expect(agus.activity.today).toBe(0);
      expect(JSON.stringify(agus)).not.toContain(office.id.B_AGENT);
    });

    it('office B’s leader reads office B’s team alone, and nothing of office A', async () => {
      const view = await read('B_AB');
      expect(view.leader!.team.map((p) => p.membershipId)).toEqual([office.id.B_AGENT]);
      expect(view.leader!.activeAgent.of).toBe(2);
      const body = JSON.stringify(view);
      for (const who of ['AGUS', 'INDAH', 'RINA', 'SARI'] as Who[]) expect(body).not.toContain(office.id[who]);
      expect(body).not.toContain('Office B meeting');
      expect(view.actions).toEqual([]);
    });
  });
});
