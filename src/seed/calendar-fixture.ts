/**
 * **The calendar fixture** (Phase 12, *Seed*; `functional/calendar.md`, *Seed*): the demo office's week and
 * month of calendar entries, defined here and inserted by `demo.ts` — nothing here writes.
 *
 * ## Which account shows what
 *
 * | Account | What it shows |
 * |---|---|
 * | `agus@kpm0417.test` (AB) | **This week, in the prototype's rhythm**: *Standup unit mingguan* on Monday and Thursday, 9:00 to 9:30 — two entries, since nothing recurs; *Sinkronisasi AAB — Sari Puspita* and *Cek pipeline* on Monday, which with the standup and his client review make **four lines on one day**, so Month draws *"+1 more…"* — or *"+2 more…"* when seeded on a Monday, his 1:1 with Indah today being a fifth; *Review goal — rencana Q4* with Sari and Arief; *Blok waktu telepon prospek* (Task); a two-day *Kunjungan klien — Surabaya* (Travel); his own *Review klien — keluarga Hartono* with an address in its notes (`Calendar_Section.html:490-491`). **Compare** with Sari: her client visit in full (ADR-0093), and the Owner's entry she attends as *Busy*. **His block on Indah** (*Block time*), with its notice. **His 1:1 with Indah today**, the day his draft with her is open. ***Kickoff tim 2026*** **four days after the run, 09:00 to 13:00** — the long event the 7 November Calendar mockup opens from the Agenda and draws in 3 Hari and Week (P19.8-T3 AC-9) |
 * | `sari@kpm0417.test` (AAB) | *Kunjungan klien — keluarga Tanjung*, a *Client meeting* with an address in its notes — **the OD-87 state** a leader walks in compare; a *Blok waktu follow up leads*; a **pending** invitation to Agus's goal review, with its inbox notice; an **accepted** one to his standups; her weekly *Coaching 1:1* with Rina on the days of her seeded sessions; *Rapat singkat unit*, which Rina **declined** |
 * | `rina@kpm0417.test` (Agent, under Sari) | Her own *Pertemuan klien — Pak Gunadi* and a task; Sari's 1:1s, whose detail links nowhere for her; the declined huddle, gone from her grid and readable from its invitation notice, read when she answered |
 * | `indah@kpm0417.test` (Agent, under Agus) | A task; the standups, **accepted**; Agus's block, read with *Close* alone, with its *Time was blocked on your calendar* notice; his 1:1 with her today |
 * | `owner@kpm0417.test` (Owner, and the root AB) | *Review leader cabang*, inviting Sari and not Agus, so it is *Busy* in Agus's compare pane |
 * | The month | The four weeks before this one in a lighter pattern — Agus's standups, Sari's follow-up block, Rina's weekly task — and the week after, so Month shows a full month, a day of the next or last month with entries, and one day with more than three lines |
 *
 * ## How it is built
 *
 * - **Clients take names no member of the office has.** The prototype's *Kusuma* and *Wijaya* are members
 *   here (Yanti Kusuma, Rina Wijaya), and P11-T2 found what a lead named after a member does to a demo.
 * - **Dates are relative to the run's today in `Asia/Jakarta`** (the office's zone), and this week is the
 *   office's Monday to Sunday holding it. Wall-clock times become instants through the calendar's own
 *   `timingOf`, so a seeded entry and a saved one are one computation.
 * - **Every `_id` is derived** from the office, the organiser and the slot (`seedObjectId`) — a slot being
 *   the entry's place in the fixture, *this week's Monday standup*, never its date — so a re-seed without
 *   `--reset` writes only what is missing. A row is dated by the run that writes it, and a later run keeps
 *   it, as the coaching fixture's are: `--reset` before a rehearsal is what makes *this week* this week again.
 * - **No entry stores a coaching session** (ADR-0099): a *Coaching 1:1* entry is an invitation, and its
 *   chip opens the session for the leader who coaches the person.
 * - **Created a week before it starts**, or a week before the run for one already under way, and each
 *   answer a day after that — never later than the run.
 */
import type { Clock } from '@/common/clock/clock.port';
import { inSource } from '@/common/i18n/sentence';
import { addDays, type LocalDate } from '@/common/time/local-day';
import type { CalendarEntryType } from '@/domain/constants';
import type { CalendarAnswer } from '@/modules/calendar/calendar-event.schema';
import { mondayOf, timingOf } from '@/modules/calendar/calendar-time';
import { seedObjectId } from './coaching-fixture';

/**
 * **The entries' words**, as their organisers typed them — in Bahasa Indonesia since P18.10-T7 (OD-238). Every row is
 * keyed by its derived `_id`, never by what it says, so a database seeded before keeps its English and gets no second
 * row; the seed's spec reads its titles from here.
 */
export const CALENDAR_WORDS = {
  standup: 'Standup unit mingguan',
  zoom: 'Zoom — zoom.us/j/91827364',
  aabSync: 'Sinkronisasi AAB — Sari Puspita',
  clientReview: 'Review klien — keluarga Hartono',
  clientReviewNotes: 'Rumah klien — Jl. Sudirman No. 12, Surabaya',
  pipeline: 'Cek pipeline',
  pipelineNotes: 'Di meja — tinjau leads minggu ini',
  prospecting: 'Blok waktu telepon prospek',
  prospectingNotes: 'Di meja — tanpa jadwal telepon, waktu fokus pribadi',
  goalReview: 'Review goal — rencana Q4',
  goalReviewNotes: 'Kantor — Ruang Rapat A, atau Google Meet: meet.google.com/xqv-pkbt-wmr',
  trip: 'Kunjungan klien — Surabaya',
  tripNotes: 'Penerbangan GA 312, pulang Sabtu malam',
  blockOnIndah: '1:1 dengan Indah Permatasari',
  oneToOne: (name: string) => `Coaching 1:1 — ${name}`,
  meetingRoom: (room: string) => `Kantor — Ruang Rapat ${room}`,
  clientVisit: 'Kunjungan klien — keluarga Tanjung',
  clientVisitNotes: 'Lokasi klien — kediaman Tanjung, Jl. Kenanga No. 7, BSD City',
  leadsFollowUp: 'Blok waktu follow up leads',
  leadsFollowUpNotes: 'Di meja — daftar telepon dari CRM',
  huddle: 'Rapat singkat unit',
  huddleNotes: 'Kantor — area terbuka',
  clientMeeting: 'Pertemuan klien — Pak Gunadi',
  clientMeetingNotes: 'Kantor — Lounge Klien',
  spaj: 'Siapkan dokumen SPAJ',
  followUpCalls: 'Telepon follow up',
  followUpCallsNotes: 'Di meja — tiga leads hangat',
  leadersReview: 'Review leader cabang',
  weeklyTask: 'Review catatan aktivitas mingguan',
  kickoff: 'Kickoff tim 2026',
} as const;
const T = CALENDAR_WORDS;

/** The members the fixture places entries for, by the seed's keys. */
export type CalendarCastKey = 'owner' | 'agus' | 'sari' | 'rina' | 'budi' | 'indah' | 'dimas' | 'siti' | 'arief';

export interface CalendarFixtureInput {
  kpmId: string;
  clock: Clock;
  timezone: string;
  members: Record<CalendarCastKey, string>;
  /** The days of Sari's finalized sessions with Rina, as the coaching fixture dates them. */
  sariRinaSessionDays: readonly LocalDate[];
}

export interface CalendarAttendeeSeed {
  membershipId: string;
  placed: boolean;
  answer: CalendarAnswer | null;
  answeredAt: Date | null;
  addedAt: Date;
}

/** One `calendarEvents` row, by `erd.md`'s names. */
export interface CalendarEntrySeed {
  _id: string;
  kpmId: string;
  organiserMembershipId: string;
  type: CalendarEntryType;
  title: string;
  notes: string;
  startsAt: Date;
  endsAt: Date;
  startsOn: LocalDate | null;
  endsOn: LocalDate | null;
  attendees: CalendarAttendeeSeed[];
  version: number;
  deletedAt: null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/** A notice the fixture's own writes sent, for `demo.ts` to deliver with its `notify`. */
export interface CalendarNoticeSeed {
  to: CalendarCastKey;
  templateId: 'calendar.invitation' | 'calendar.block_placed';
  payload: { entryId: string; date: LocalDate };
  sentAt: Date;
  /** Read when its member answered the invitation, as the stored entry dates the answer; unread otherwise. */
  readOnAnswer: boolean;
}

export interface CalendarFixture {
  /** The run's today in the office's zone, and the Monday of its week. */
  today: LocalDate;
  monday: LocalDate;
  entries: CalendarEntrySeed[];
  notices: CalendarNoticeSeed[];
  /** The entries a walk opens by name: the OD-87 state, the busy one, the block, the answers. */
  marked: {
    sariClientVisit: string;
    ownerReview: string;
    agusBlockOnIndah: string;
    goalReview: string;
    declinedHuddle: string;
    busiestDay: LocalDate;
  };
}

const DAY_MS = 86_400_000;

/** A timed entry or a trip, as a slot of the fixture states it. */
type Slot = {
  slot: string;
  by: CalendarCastKey;
  type: CalendarEntryType;
  title: string;
  notes?: string;
  /** Who is on it, each with their answer, or `placed` for the member a block was placed on. */
  with?: [CalendarCastKey, CalendarAnswer | 'placed'][];
} & ({ date: LocalDate; start: string; end: string } | { startsOn: LocalDate; endsOn: LocalDate });

export function buildCalendarFixture(input: CalendarFixtureInput): CalendarFixture {
  const { kpmId, clock, timezone, members } = input;
  const now = clock.now();
  const today = clock.localDateFor(timezone, now);
  const monday = mondayOf(today);
  const day = (offset: number) => addDays(monday, offset);

  const slots: Slot[] = [];
  const standupWith: [CalendarCastKey, CalendarAnswer][] = [
    ['indah', 'accepted'], ['dimas', 'pending'], ['siti', 'accepted'], ['sari', 'accepted'], ['arief', 'pending'],
  ];
  const standup = (week: number, weekday: number): Slot => ({
    slot: `w${week}:standup:${weekday}`, by: 'agus', type: 'meeting', title: T.standup, notes: T.zoom,
    date: day(week * 7 + weekday), start: '09:00', end: '09:30', with: standupWith,
  });

  // ---- This week: Agus.
  slots.push(
    standup(0, 0),
    standup(0, 3),
    { slot: 'w0:aab-sync', by: 'agus', type: 'meeting', title: T.aabSync, notes: T.zoom, date: day(0), start: '10:00', end: '10:30', with: [['sari', 'accepted']] },
    { slot: 'w0:client-review', by: 'agus', type: 'client', title: T.clientReview, notes: T.clientReviewNotes, date: day(0), start: '14:00', end: '15:00' },
    { slot: 'w0:pipeline', by: 'agus', type: 'task', title: T.pipeline, notes: T.pipelineNotes, date: day(0), start: '16:00', end: '16:30' },
    { slot: 'w0:prospecting', by: 'agus', type: 'task', title: T.prospecting, notes: T.prospectingNotes, date: day(1), start: '10:00', end: '11:30' },
    { slot: 'w0:goal-review', by: 'agus', type: 'meeting', title: T.goalReview, notes: T.goalReviewNotes, date: day(2), start: '09:00', end: '10:00', with: [['sari', 'pending'], ['arief', 'pending']] },
    { slot: 'w0:trip', by: 'agus', type: 'travel', title: T.trip, notes: T.tripNotes, startsOn: day(4), endsOn: day(5) },
    // *Block time* on Indah: the leader's entry, Indah placed on it (ADR-0098).
    { slot: 'w0:block-indah', by: 'agus', type: 'coaching', title: T.blockOnIndah, notes: T.meetingRoom('2'), date: day(2), start: '15:00', end: '15:30', with: [['indah', 'placed']] },
    // His 1:1 with Indah today, the day his draft with her is open.
    { slot: 'today:one-to-one-indah', by: 'agus', type: 'coaching', title: T.oneToOne('Indah Permatasari'), notes: T.meetingRoom('2'), date: today, start: '13:00', end: '14:00', with: [['indah', 'accepted']] },
    // P19.8-T3 AC-9: a morning-long event later in the Agenda's seven days — the mockup's *Kickoff 2026*, 09.00–13.00 —
    // in 3 Hari's and Week's grid from 07.00, and the one the mockup opens its detail from.
    { slot: 'ahead:kickoff', by: 'agus', type: 'meeting', title: T.kickoff, notes: T.meetingRoom('A'), date: addDays(today, 4), start: '09:00', end: '13:00' },
  );

  // ---- This week: Sari, Rina, Indah and the Owner.
  slots.push(
    { slot: 'w0:client-visit', by: 'sari', type: 'client', title: T.clientVisit, notes: T.clientVisitNotes, date: day(2), start: '10:00', end: '11:00' },
    { slot: 'w0:leads-follow-up', by: 'sari', type: 'task', title: T.leadsFollowUp, notes: T.leadsFollowUpNotes, date: day(3), start: '13:00', end: '14:00' },
    { slot: 'w0:huddle', by: 'sari', type: 'meeting', title: T.huddle, notes: T.huddleNotes, date: day(1), start: '16:00', end: '16:30', with: [['rina', 'declined'], ['budi', 'accepted']] },
    { slot: 'w0:client-meeting', by: 'rina', type: 'client', title: T.clientMeeting, notes: T.clientMeetingNotes, date: day(1), start: '14:00', end: '15:00' },
    { slot: 'w0:spaj', by: 'rina', type: 'task', title: T.spaj, date: day(2), start: '08:00', end: '09:00' },
    { slot: 'w0:follow-up-calls', by: 'indah', type: 'task', title: T.followUpCalls, notes: T.followUpCallsNotes, date: day(1), start: '15:00', end: '16:00' },
    { slot: 'w0:leaders-review', by: 'owner', type: 'meeting', title: T.leadersReview, notes: T.meetingRoom('B'), date: day(3), start: '15:00', end: '16:00', with: [['sari', 'accepted']] },
  );

  // ---- Sari's weekly 1:1 with Rina, on the days of her seeded sessions.
  for (const [n, date] of [...input.sariRinaSessionDays].sort().entries()) {
    slots.push({ slot: `session-${n}:one-to-one-rina`, by: 'sari', type: 'coaching', title: T.oneToOne('Rina Wijaya'), notes: T.meetingRoom('3'), date, start: '11:00', end: '12:00', with: [['rina', 'accepted']] });
  }

  // ---- The four weeks before, lighter, and the week after.
  for (const week of [-4, -3, -2, -1, 1]) {
    slots.push(
      standup(week, 0),
      standup(week, 3),
      { slot: `w${week}:leads-follow-up`, by: 'sari', type: 'task', title: T.leadsFollowUp, notes: T.leadsFollowUpNotes, date: day(week * 7 + 3), start: '13:00', end: '14:00' },
      { slot: `w${week}:weekly-task`, by: 'rina', type: 'task', title: T.weeklyTask, date: day(week * 7 + 4), start: '16:00', end: '16:30' },
    );
  }

  const entries: CalendarEntrySeed[] = [];
  const notices: CalendarNoticeSeed[] = [];
  const idOf = new Map<string, string>();
  for (const s of slots) {
    const timing = 'date' in s
      ? timingOf(s.type, { date: s.date, start: s.start, end: s.end }, timezone)
      : timingOf(s.type, { startsOn: s.startsOn, endsOn: s.endsOn }, timezone);
    if ('violations' in timing) {
      throw new Error(`The calendar fixture's ${s.slot} is not an entry: ${timing.violations.map(inSource).join(' ')}`);
    }
    const date = 'date' in s ? s.date : s.startsOn;
    const organiser = members[s.by];
    const _id = seedObjectId('calendarEvent', kpmId, organiser, s.slot);
    const createdAt = new Date(Math.min(now.getTime(), timing.timing.startsAt.getTime()) - 7 * DAY_MS);
    const answeredAt = new Date(Math.min(now.getTime(), createdAt.getTime() + DAY_MS));
    entries.push({
      _id, kpmId, organiserMembershipId: organiser, type: s.type, title: s.title, notes: s.notes ?? '',
      ...timing.timing,
      attendees: (s.with ?? []).map(([key, answer]) => ({
        membershipId: members[key],
        placed: answer === 'placed',
        answer: answer === 'placed' ? null : answer,
        answeredAt: answer === 'placed' || answer === 'pending' ? null : answeredAt,
        addedAt: createdAt,
      })),
      version: 1, deletedAt: null, createdAt, createdBy: organiser, updatedAt: createdAt, updatedBy: organiser,
    });
    idOf.set(s.slot, _id);
    if (s.slot === 'w0:block-indah') {
      notices.push({ to: 'indah', templateId: 'calendar.block_placed', payload: { entryId: _id, date }, sentAt: createdAt, readOnAnswer: false });
    }
    if (s.slot === 'w0:goal-review') {
      notices.push({ to: 'sari', templateId: 'calendar.invitation', payload: { entryId: _id, date }, sentAt: createdAt, readOnAnswer: false });
    }
    // Rina's invitation to the huddle she declined: off her grid, and opened from this notice.
    if (s.slot === 'w0:huddle') {
      notices.push({ to: 'rina', templateId: 'calendar.invitation', payload: { entryId: _id, date }, sentAt: createdAt, readOnAnswer: true });
    }
  }

  return {
    today,
    monday,
    entries,
    notices,
    marked: {
      sariClientVisit: idOf.get('w0:client-visit')!,
      ownerReview: idOf.get('w0:leaders-review')!,
      agusBlockOnIndah: idOf.get('w0:block-indah')!,
      goalReview: idOf.get('w0:goal-review')!,
      declinedHuddle: idOf.get('w0:huddle')!,
      busiestDay: day(0),
    },
  };
}
