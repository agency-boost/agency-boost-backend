import mongoose from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { addDays, localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { seedObjectId } from './coaching-fixture';

/**
 * **Advanced analytics › *Event*, with a year of events behind it** (P19.25-T1, T2; ADR-0281; the phase file's *Seed*:
 * *"15+ past events with attendance and feedback (some with few answers), two upcoming events with invite answers (incl.
 * declines with reasons)"*). Runs after `events-fixture.ts`, whose seven events stay as they are: PRULink and the Town
 * Hall recorded, the Bootcamp recorded for its chosen agents, *Klinik penjualan* **not recorded** (*Belum dicatat*).
 *
 * - **Twelve past events for everybody** in 0417, from about ten months ago to three weeks ago, each with **its roll call
 *   taken for every member who was in it** — hadir from each member's own steady habit, so *Per orang* has its lowest and
 *   its highest — confirmed by the Owner (the Admin confirms the Owner, ADR-0138 §2), and an answer from about half of
 *   those hadir. *Recruitment Day* and *Briefing PRUWell* draw only one or two answers (*sedikit jawaban*).
 * - **Two planned events**: *Rapat bulanan kantor* tomorrow (*Besok*) and *Closing clinic akhir tahun* in thirteen days —
 *   about half going, three declining **with a reason**, the rest *Belum jawab*.
 * - **Test accounts are never in it** (ADR-0267 §1): the members read are 0417's real ones.
 *
 * Every date counts from the run's today in Jakarta. **Derived ids, written once until `--reset`**: a re-run writes
 * nothing, and a walk's own answers and roll calls are kept.
 */

/** The twelve past events: their code, title, type, days from today, the local hour, and how well they were liked. */
const PAST_EVENTS = [
  { code: 'EA_KICKOFF', title: 'Kick-off tahun ini', type: 'COMMUNITY', days: -300, hour: 9, mood: 9 },
  { code: 'EA_TOWNHALL_FEB', title: 'Town Hall Februari', type: 'COMMUNITY', days: -280, hour: 15, mood: 8 },
  { code: 'EA_PRUPRIME', title: 'Product briefing PRUPrime', type: 'PRODUCT_LAUNCH', days: -265, hour: 14, mood: 7 },
  { code: 'EA_TOWNHALL_MAR', title: 'Town Hall Maret', type: 'COMMUNITY', days: -250, hour: 15, mood: 8 },
  { code: 'EA_TOWNHALL_APR', title: 'Town Hall April', type: 'COMMUNITY', days: -220, hour: 15, mood: 8 },
  { code: 'EA_RECRUITMENT_DAY', title: 'Recruitment Day', type: 'RECRUITMENT', days: -190, hour: 10, mood: 6, few: 2 },
  { code: 'EA_TOWNHALL_JUN', title: 'Town Hall Juni', type: 'COMMUNITY', days: -160, hour: 15, mood: 8 },
  { code: 'EA_PRUWELL', title: 'Briefing PRUWell', type: 'PRODUCT_LAUNCH', days: -145, hour: 14, mood: 7, few: 1 },
  { code: 'EA_KICKOFF_JUL', title: 'Kick-off semester dua', type: 'COMMUNITY', days: -130, hour: 9, mood: 8 },
  { code: 'EA_MDRT_SHARING', title: 'MDRT Sharing', type: 'RECOGNITION', days: -115, hour: 16, mood: 9 },
  { code: 'EA_CLOSING_CLINIC', title: 'Closing Clinic', type: 'TRAINING', days: -85, hour: 13, mood: 7 },
  { code: 'EA_TOWNHALL_SEP', title: 'Town Hall September', type: 'COMMUNITY', days: -60, hour: 15, mood: 6 },
] as const;

/** The two planned events. */
const UPCOMING_EVENTS = [
  { code: 'EA_MONTHLY', title: 'Rapat bulanan kantor', type: 'COMMUNITY', days: 1, hour: 15 },
  { code: 'EA_CLOSING_YEAR', title: 'Closing clinic akhir tahun', type: 'TRAINING', days: 13, hour: 13 },
] as const;

/** The reasons members gave for *Tidak ikut*. */
export const DECLINE_REASONS = ['Ada janji nasabah', 'Sedang di luar kota', 'Ujian AAJI hari itu'] as const;

/** What members wrote: why they gave the score, and what could be better, by how they felt. */
const WHY = {
  high: ['Materinya langsung bisa dipakai untuk nasabah.', 'Pengakuan untuk agent baru bikin semangat.', 'Sesi tanya jawab dengan top producer sangat membantu.'],
  mid: ['Materinya bagus, tapi terlalu lama dan banyak sambutan.', 'Cukup bermanfaat, walau sebagian sudah pernah dibahas.'],
  low: ['Tempat penuh, suara di belakang kurang jelas.', 'Terasa mengulang acara sebelumnya.'],
} as const;
const IMPROVE = ['Kurangi sambutan, langsung ke materi.', 'Mulai tepat waktu.', 'Bagikan materi setelah acara.', 'Tambah latihan role play.', 'Sound system perlu dicek dulu.'] as const;

export interface EventAnalyticsFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** Who confirms: the Owner everybody, the Admin the Owner. */
  ownerId: string;
  adminId: string;
}

export interface EventAnalyticsFixture {
  written: number;
  guide: string;
}

/** A number from 0 to 99, fixed for its parts: the same member and event give the same habit on every run. */
function roll(...parts: string[]): number {
  return parseInt(seedObjectId('event-analytics-fixture', ...parts).slice(0, 6), 16) % 100;
}

export async function seedEventAnalyticsFixture(deps: EventAnalyticsFixtureDeps): Promise<EventAnalyticsFixture> {
  const db = mongoose.connection.db!;
  const { clock, kpmId, ownerId, adminId } = deps;
  const timezone = DEFAULT_TENANT_TIMEZONE;
  const today = localDayOf(clock.now(), timezone);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  const at = (days: number, hour: number) =>
    new Date(clock.startOfLocalDay(timezone, addDays(today, days)).getTime() + hour * 3_600_000);
  let written = 0;

  // 0417's real members — test accounts never counted (ADR-0267 §1) — with when they joined.
  const members = await db.collection('memberships').find(
    { kpmId, status: 'active', deletedAt: null, testAccount: { $ne: true } },
    { projection: { joinedAt: 1 } },
  ).sort({ agentSeq: 1 }).toArray();

  /*
   * The event, and when it starts: **the stored start of one an earlier run wrote**, never today's offset again — whom
   * its roll call expects is read against it, and a run on a later day would otherwise reach a member who joined since
   * the first run's start and write them a row (the coaching seed's next-day run, P11-T2 AC-6).
   */
  const writeEvent = async (code: string, row: Record<string, unknown>, startsAt: Date): Promise<{ id: string; startsAt: Date }> => {
    const existing = await db.collection('events').findOne({ kpmId, code, deletedAt: null });
    if (existing) return { id: String(existing._id), startsAt: existing.startsAt as Date };
    const id = seedObjectId('event-analytics-fixture', kpmId, 'event', code);
    await db.collection('events').insertOne({
      _id: oid(id), kpmId, code, ...row, startsAt, endsAt: new Date(startsAt.getTime() + 2 * 3_600_000),
      location: 'Kantor KPM', locationUrl: null, description: '',
      audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
      version: 1, status: 'active', archivedAt: null, deletedAt: null, createdBy: ownerId, updatedBy: ownerId,
      createdAt: clock.now(), updatedAt: clock.now(), __v: 0,
    });
    written += 1;
    return { id, startsAt };
  };
  const writeRsvp = async (eventId: string, code: string, membershipId: string, fields: Record<string, unknown>) => {
    const id = seedObjectId('event-analytics-fixture', kpmId, 'rsvp', code, membershipId);
    if (await db.collection('eventRsvps').findOne({ kpmId, eventId, membershipId, deletedAt: null })) return;
    await db.collection('eventRsvps').insertOne({
      _id: oid(id), kpmId, eventId, membershipId, rsvpStatus: null, rsvpAt: null, cancelledAt: null, declineReason: null,
      claimedAt: null, confirmedAttended: null, confirmedByMembershipId: null, confirmedAt: null,
      deletedAt: null, createdBy: membershipId, updatedBy: membershipId, createdAt: clock.now(), updatedAt: clock.now(),
      ...fields,
    });
    written += 1;
  };

  // ---- the past events, their roll calls and their answers.
  for (const event of PAST_EVENTS) {
    const { id: eventId, startsAt } = await writeEvent(event.code, { typeCode: event.type, title: event.title, blurb: '' }, at(event.days, event.hour));
    const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
    let answered = 0;
    for (const [i, m] of members.entries()) {
      const membershipId = String(m._id);
      // Only those who were members when it began are expected (ADR-0039).
      if (m.joinedAt && (m.joinedAt as Date).getTime() > startsAt.getTime()) continue;
      // A steady habit per member — from about one event in five to nearly all — and a little luck per event.
      const habit = 20 + (roll(kpmId, 'habit', membershipId) * 75) / 100;
      const hadir = roll(kpmId, event.code, membershipId) < habit;
      await writeRsvp(eventId, event.code, membershipId, {
        rsvpStatus: hadir ? 'going' : null,
        rsvpAt: hadir ? new Date(startsAt.getTime() - 48 * 3_600_000) : null,
        confirmedAttended: hadir,
        confirmedByMembershipId: membershipId === ownerId ? adminId : ownerId,
        confirmedAt: new Date(endsAt.getTime() + 20 * 3_600_000),
      });
      const wantsToAnswer = 'few' in event ? answered < event.few : roll(kpmId, 'answer', event.code, membershipId) < 55;
      if (!hadir || !wantsToAnswer) continue;
      const score = Math.max(0, Math.min(10, event.mood + ((roll(kpmId, 'score', event.code, membershipId) % 7) - 3)));
      const pool = score >= 9 ? WHY.high : score >= 7 ? WHY.mid : WHY.low;
      const answerId = seedObjectId('event-analytics-fixture', kpmId, 'feedback', event.code, membershipId);
      if (!(await db.collection('eventFeedback').findOne({ kpmId, eventId, membershipId, deletedAt: null }))) {
        const submittedAt = new Date(endsAt.getTime() + 4 * 3_600_000);
        await db.collection('eventFeedback').insertOne({
          _id: oid(answerId), kpmId, eventId, membershipId, score,
          why: i % 3 === 2 ? '' : pool[i % pool.length],
          improve: i % 2 === 0 ? IMPROVE[i % IMPROVE.length] : '',
          submittedAt, deletedAt: null, createdBy: membershipId, updatedBy: membershipId, createdAt: submittedAt, updatedAt: submittedAt,
        });
        written += 1;
      }
      answered += 1;
    }
  }

  // ---- the planned events and the answers to their invitation.
  for (const event of UPCOMING_EVENTS) {
    const { id: eventId } = await writeEvent(event.code, { typeCode: event.type, title: event.title, blurb: '' }, at(event.days, event.hour));
    let declined = 0;
    for (const m of members) {
      const membershipId = String(m._id);
      const r = roll(kpmId, 'invite', event.code, membershipId);
      if (r < 50) {
        await writeRsvp(eventId, event.code, membershipId, { rsvpStatus: 'going', rsvpAt: new Date(clock.now().getTime() - 24 * 3_600_000) });
      } else if (r < 70 && declined < DECLINE_REASONS.length) {
        await writeRsvp(eventId, event.code, membershipId, {
          rsvpStatus: 'cancelled', cancelledAt: new Date(clock.now().getTime() - 12 * 3_600_000), declineReason: DECLINE_REASONS[declined],
        });
        declined += 1;
      }
    }
  }

  const guide = `
  ADVANCED ANALYTICS › EVENT at /kpm/advanced-analytics/events  (from src/seed/event-analytics-fixture.ts)
    owner@ · admin@kpm0417.test  Kehadiran: ${PAST_EVENTS.length} more past events with their roll call (15+ in the year);
                                 Akan datang: ${UPCOMING_EVENTS[0].title} (Besok) and ${UPCOMING_EVENTS[1].title}
                                 (13 hari lagi) — Akan ikut, Tidak ikut with a reason, Belum jawab; Klinik penjualan
                                 reads Belum dicatat. Feedback: ${PAST_EVENTS[5].title} and ${PAST_EVENTS[7].title}
                                 with sedikit jawaban. Per group / Per orang over the last 15 recorded events.
    Pengaturan › Events          Lihat masukan › on a past row opens it; ⋯ › Catat kehadiran opens the roll call.
`;
  return { written, guide };
}
