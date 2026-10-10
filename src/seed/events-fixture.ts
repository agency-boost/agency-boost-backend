import mongoose from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { addDays, localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { seedObjectId } from './coaching-fixture';

/**
 * **Events, as their audience lives them** (Phase 18.5, P18.5-T5 AC-11, P18.5-T6 AC-8; the phase file's *Seed*):
 * 0417's members' RSVPs, claims, the roll call's confirmations and their answers, over the three events `configure()`
 * writes for every office (*Kickoff 2026*, *Leaders' huddle*, *PRULink briefing*) and four new ones. Every date
 * counts from the run's today in Jakarta. **No member, activity day, goal or production month is added**: every row
 * is an event of 0417 or a row of `eventRsvps` / `eventFeedback`, which nothing reviewed before this phase reads.
 *
 * | Event | When | Audience | Rows |
 * |---|---|---|---|
 * | *Product refresh briefing* *(new)* | in 5 days | all | Rina going → *Going*; Budi going, then cancelled |
 * | *Kickoff 2026* | in 14 days | all | none: Rina's *Upcoming*, *Join event* |
 * | *Leaders' huddle* | **running**: `configure()` dates it from an hour before the run to six hours after | leaders | Agus and Sari going; Dewi (leads nobody) and Rina do not see it |
 * | *PRULink briefing* | 21 days ago | company · all | Rina going, no answer → *Feedback pending*; Budi going, confirmed, 9; Indah said she came, **unconfirmed**, 6; Dimas going, **marked absent**; Siti nothing → NPS 100 over one confirmed answer, *"· 1 awaiting attendance confirmation"* |
 * | *{Month} Town Hall* *(new; `KPM_Owner.html:1655`, `:2984`)* | 35 days ago | all | **Eight confirmed answers with the prototype's scores and words** (`KPM_Owner.html:2990-2998`) — the Owner's 10, confirmed by the Admin; Agus 9, Indah 9, Sari 8, Siti 7, Dimas 6, Novi 5, Dewi 4 → *NPS 0 · 8 responses*, as drawn; Rina nothing → *Didn't join*, *I actually attended this event* |
 * | *New Agent Bootcamp* *(new)* | 50 days ago | chosen agents: Rina, Budi, Yanti's first membership | Rina going, 9 with *Why* → the thanks block; Yanti's first membership confirmed with an answer, kept with it; her second membership does not see the event |
 * | *Sales clinic* *(new)* | 10 days ago | all | nothing → the empty roll call, *—* and *"No feedback yet."* |
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `rina@kpm0417.test` | `/events`: *Going* (Product refresh), *Upcoming* (Kickoff), *Feedback pending* (PRULink, the form), *Didn't join* (Town Hall, Sales clinic), *Feedback sent* (Bootcamp, the thanks); no *Leaders' huddle* |
 * | `budi@kpm0417.test` | The cancelled RSVP on Product refresh — *Not joined*, *Join event* |
 * | `agus@` · `sari@` | *Leaders' huddle* among *Going*; `GET /kpm/settings/events` answered 403 |
 * | `dewi@` | No *Leaders' huddle* |
 * | `owner@` · `admin@` | `/kpm/settings/events` › *View feedback*: the Town Hall at *NPS 0 · 8 responses*; PRULink with one awaiting and one absent; the Owner's own row disabled for the Owner, confirmable by the Admin; *Sales clinic* empty |
 * | `removed@kpm0417.test` (Yanti) | Her current membership does not see the Bootcamp; her first membership's rows stay |
 *
 * **Derived ids, written once until `--reset`**: an event, a row or an answer already there is left as it is, so a
 * re-run writes nothing and a walk's own RSVPs, claims, confirmations and answers are kept. The seed's inbox reminders
 * of the three `configure()` events are untouched (nothing sends `EVENT_REMINDER`; the phase file, *Found while
 * preparing* 5).
 */

/** The Town Hall's eight answers, verbatim from `KPM_Owner.html:2990-2998`, in the prototype's order. */
const TOWN_HALL_ANSWERS: readonly [score: number, why: string, improve: string][] = [
  [10, 'Great energy — the recognition segment really landed.', 'Keep leaning into recognition moments — repeat this format.'],
  [9, 'Loved the live Q&A, felt very transparent.', 'Keep the live Q&A as a permanent segment.'],
  [9, 'Best town hall yet — very clear on Q3 priorities.', 'Keep leading with clear quarterly priorities.'],
  [8, 'Solid updates, would love more time for Q&A.', 'Extend the Q&A window by 10–15 minutes.'],
  [7, 'Good content, but audio cut out twice.', 'Test the mic/AV setup before going live.'],
  [6, 'Ran a bit long, energy dipped toward the end.', 'Trim the agenda — end while energy is still high.'],
  [5, 'Too long — could be tightened up.', 'Cut 15–20 minutes from the overall runtime.'],
  [4, "Felt repetitive compared to last quarter's.", "Refresh the content — avoid repeating last quarter's deck."],
];

/** Who answered the Town Hall, in the answers' order: members present 35 days ago, Rina left out. */
const TOWN_HALL_CAST = ['owner', 'agus', 'indah', 'sari', 'siti', 'dimas', 'novi', 'dewi'] as const;

export type EventsCastKey =
  | 'owner' | 'admin' | 'agus' | 'sari' | 'dewi' | 'rina' | 'budi' | 'indah' | 'dimas' | 'siti' | 'novi' | 'yantiFirst';

export interface EventsFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** Membership ids, by who. `yantiFirst` is Yanti's first, removed membership. */
  cast: Record<EventsCastKey, string>;
}

export interface EventsFixture {
  /** Rows this run wrote, across `events`, `eventRsvps` and `eventFeedback`; 0 on a re-run. */
  written: number;
  /** The event ids the fixture names, by code — the three `configure()` wrote and the four it adds. */
  events: Record<string, string>;
  /** The run's printed guide section. */
  guide: string;
}

/** The four events the fixture adds, by code: days from today in Jakarta, the local start hour, and their length. */
const NEW_EVENTS = {
  PRODUCT_REFRESH: { days: 5, hour: 14, hours: 2 },
  TOWN_HALL: { days: -35, hour: 15, hours: 2 },
  NEW_AGENT_BOOTCAMP: { days: -50, hour: 8, hours: 8 },
  SALES_CLINIC: { days: -10, hour: 13, hours: 2 },
} as const;

export async function seedEventsFixture(deps: EventsFixtureDeps): Promise<EventsFixture> {
  const db = mongoose.connection.db!;
  const { clock, kpmId, cast } = deps;
  const timezone = DEFAULT_TENANT_TIMEZONE;
  const today = localDayOf(clock.now(), timezone);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);
  let written = 0;

  /** `hour`:00 in Jakarta on the day `days` from today. */
  const at = (days: number, hour: number) =>
    new Date(clock.startOfLocalDay(timezone, addDays(today, days)).getTime() + hour * 3_600_000);

  // ---- the four new events, each written once by its derived id and its code.
  const townHallStart = at(NEW_EVENTS.TOWN_HALL.days, NEW_EVENTS.TOWN_HALL.hour);
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: timezone }).format(townHallStart);
  const drafts: Record<keyof typeof NEW_EVENTS, Record<string, unknown>> = {
    PRODUCT_REFRESH: {
      typeCode: 'PRODUCT_LAUNCH', title: 'Product refresh briefing',
      blurb: 'Updated riders and pricing ahead of the next launch.',
      description: 'A walkthrough of the updated product riders, revised pricing tables, and talking points to use with clients.',
      location: 'Online — Zoom', locationUrl: 'https://meet.example.test/product-refresh',
      audience: { issuer: 'company', scope: 'all_agents', inviteeMembershipIds: [] },
    },
    TOWN_HALL: {
      typeCode: 'COMMUNITY', title: `${monthName} Town Hall`,
      blurb: 'The quarter so far, recognition, and an open Q&A.',
      description: 'The whole office together: where we stand this quarter, who we are recognising, and an open Q&A with the Owner.',
      location: 'Kantor KPM, Ruang serbaguna', locationUrl: null,
      audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
    },
    NEW_AGENT_BOOTCAMP: {
      typeCode: 'TRAINING', title: 'New Agent Bootcamp',
      blurb: 'A day of onboarding for newly registered agents.',
      description: 'Product basics, compliance, and first-30-days activity targets for newly registered agents.',
      location: 'Kantor KPM, Ruang pelatihan', locationUrl: null,
      audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [cast.rina, cast.budi, cast.yantiFirst] },
    },
    SALES_CLINIC: {
      typeCode: 'TRAINING', title: 'Sales clinic',
      blurb: 'Bring one case you are stuck on.',
      description: 'A working session: each agent brings one prospect they are stuck on, and the room works it through.',
      location: 'Kantor KPM', locationUrl: null,
      audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
    },
  };
  const ids: Record<string, string> = {};
  for (const [code, when] of Object.entries(NEW_EVENTS) as [keyof typeof NEW_EVENTS, (typeof NEW_EVENTS)[keyof typeof NEW_EVENTS]][]) {
    const id = seedObjectId('events-fixture', kpmId, 'event', code);
    const existing = await db.collection('events').findOne({ kpmId, code, deletedAt: null });
    if (existing) {
      ids[code] = String(existing._id);
      continue;
    }
    const startsAt = at(when.days, when.hour);
    await db.collection('events').insertOne({
      _id: oid(id), kpmId, code, ...drafts[code], startsAt, endsAt: new Date(startsAt.getTime() + when.hours * 3_600_000),
      version: 1, status: 'active', archivedAt: null, deletedAt: null, createdBy: cast.owner, updatedBy: cast.owner,
      createdAt: clock.now(), updatedAt: clock.now(), __v: 0,
    });
    ids[code] = id;
    written += 1;
  }
  for (const code of ['KICKOFF', 'LEADERS_HUDDLE', 'PRULINK_BRIEFING']) {
    const row = await db.collection('events').findOne({ kpmId, code, deletedAt: null });
    if (!row) throw new Error(`0417 has no ${code} event: configure() writes it before this fixture runs`);
    ids[code] = String(row._id);
  }
  const startOf = async (code: string) => ((await db.collection('events').findOne({ _id: oid(ids[code]) }))!.startsAt as Date);
  const endOf = async (code: string) => ((await db.collection('events').findOne({ _id: oid(ids[code]) }))!.endsAt as Date);

  // ---- the members' rows.
  interface RsvpPlan {
    rsvp?: 'going' | 'cancelled';
    claimed?: boolean;
    confirmed?: { attended: boolean; by: EventsCastKey };
    answer?: [score: number, why: string, improve: string];
  }
  const plan: Record<string, Partial<Record<EventsCastKey, RsvpPlan>>> = {
    PRODUCT_REFRESH: { rina: { rsvp: 'going' }, budi: { rsvp: 'cancelled' } },
    LEADERS_HUDDLE: { agus: { rsvp: 'going' }, sari: { rsvp: 'going' } },
    PRULINK_BRIEFING: {
      rina: { rsvp: 'going' },
      budi: { rsvp: 'going', confirmed: { attended: true, by: 'owner' }, answer: [9, 'Clear on how to position the rider.', ''] },
      indah: { claimed: true, answer: [6, 'Useful, but the call dropped twice.', 'Send the slides before the call.'] },
      dimas: { rsvp: 'going', confirmed: { attended: false, by: 'owner' } },
    },
    TOWN_HALL: Object.fromEntries(TOWN_HALL_CAST.map((who, i) => [who, {
      rsvp: 'going',
      // Nobody confirms their own: the Admin confirms the Owner, the Owner everybody else.
      confirmed: { attended: true, by: who === 'owner' ? 'admin' : 'owner' },
      answer: TOWN_HALL_ANSWERS[i],
    } satisfies RsvpPlan])),
    NEW_AGENT_BOOTCAMP: {
      rina: { rsvp: 'going', answer: [9, 'Clear and practical — I left with a plan for my first 30 days.', ''] },
      yantiFirst: {
        rsvp: 'going', confirmed: { attended: true, by: 'owner' },
        answer: [8, 'Good pace, lots to take in.', 'A one-page summary to take home.'],
      },
    },
  };

  for (const [code, rows] of Object.entries(plan)) {
    const startsAt = await startOf(code);
    const endsAt = await endOf(code);
    const hourBefore = (n: number) => new Date(startsAt.getTime() - n * 3_600_000);
    const hourAfter = (n: number) => new Date(endsAt.getTime() + n * 3_600_000);
    for (const [who, row] of Object.entries(rows) as [EventsCastKey, RsvpPlan][]) {
      const membershipId = cast[who];
      const rsvpId = seedObjectId('events-fixture', kpmId, 'rsvp', code, who);
      if (!(await db.collection('eventRsvps').findOne({ _id: oid(rsvpId) }))
        && !(await db.collection('eventRsvps').findOne({ kpmId, eventId: ids[code], membershipId, deletedAt: null }))) {
        const rsvpAt = row.rsvp ? hourBefore(48) : null;
        await db.collection('eventRsvps').insertOne({
          _id: oid(rsvpId), kpmId, eventId: ids[code], membershipId,
          rsvpStatus: row.rsvp ?? null, rsvpAt, cancelledAt: row.rsvp === 'cancelled' ? hourBefore(24) : null,
          claimedAt: row.claimed ? hourAfter(2) : null,
          confirmedAttended: row.confirmed ? row.confirmed.attended : null,
          confirmedByMembershipId: row.confirmed ? cast[row.confirmed.by] : null,
          confirmedAt: row.confirmed ? hourAfter(20) : null,
          deletedAt: null, createdBy: membershipId, updatedBy: row.confirmed ? cast[row.confirmed.by] : membershipId,
          createdAt: rsvpAt ?? hourAfter(2), updatedAt: row.confirmed ? hourAfter(20) : (rsvpAt ?? hourAfter(2)),
        });
        written += 1;
      }
      if (row.answer) {
        const answerId = seedObjectId('events-fixture', kpmId, 'feedback', code, who);
        if (!(await db.collection('eventFeedback').findOne({ _id: oid(answerId) }))
          && !(await db.collection('eventFeedback').findOne({ kpmId, eventId: ids[code], membershipId, deletedAt: null }))) {
          const [score, why, improve] = row.answer;
          await db.collection('eventFeedback').insertOne({
            _id: oid(answerId), kpmId, eventId: ids[code], membershipId, score, why, improve, submittedAt: hourAfter(4),
            deletedAt: null, createdBy: membershipId, updatedBy: membershipId, createdAt: hourAfter(4), updatedAt: hourAfter(4),
          });
          written += 1;
        }
      }
    }
  }
  // The title as stored: a re-run on a later day prints the month the event was written with, never today's.
  const townHall = String((await db.collection('events').findOne({ _id: oid(ids.TOWN_HALL) }))!.title);
  const guide = `
  EVENTS at /events and /kpm/settings/events  (from src/seed/events-fixture.ts)
    rina@kpm0417.test            /events: Going (Product refresh briefing), Upcoming (Kickoff 2026), Feedback
                                 pending (PRULink briefing: the form), Didn't join (${townHall}, Sales clinic:
                                 "I actually attended this event"), Feedback sent (New Agent Bootcamp: the
                                 thanks). No Leaders' huddle
    budi@kpm0417.test            Product refresh briefing RSVP cancelled: Not joined, Join event
    agus@ · sari@kpm0417.test    Leaders' huddle among Going; GET /kpm/settings/events answered 403
    dewi@kpm0417.test            leads nobody: no Leaders' huddle
    owner@ · admin@kpm0417.test  Settings › Events › View feedback on a past row: ${townHall} at NPS 0 ·
                                 8 responses (the Owner's own row disabled for the Owner, confirmable by
                                 the Admin); PRULink with one awaiting confirmation and one marked absent;
                                 Sales clinic empty — "No feedback yet."
    removed@kpm0417.test         Yanti's current membership does not see the New Agent Bootcamp; her first
                                 membership's confirmed answer stays with it
`;
  return { written, events: ids, guide };
}
