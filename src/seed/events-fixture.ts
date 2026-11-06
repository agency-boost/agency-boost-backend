import mongoose from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { addDays, localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { seedObjectId } from './coaching-fixture';

/**
 * **Events, as their audience lives them** (Phase 18.2, P18.2-T5 AC-11, P18.2-T6 AC-8; the phase file's *Seed*):
 * 0417's members' RSVPs, claims, the roll call's confirmations and their answers, over the three events `configure()`
 * writes for every office (*Kickoff 2026*, *Rapat leader*, *Briefing PRULink*; their titles in `CONFIGURED_EVENTS`) and four new ones. Every date
 * counts from the run's today in Jakarta. **No member, activity day, goal or production month is added**: every row
 * is an event of 0417 or a row of `eventRsvps` / `eventFeedback`, which nothing reviewed before this phase reads.
 *
 * | Event | When | Audience | Rows |
 * |---|---|---|---|
 * | *Briefing pembaruan produk* *(new)* | in 5 days | all | Rina going → *Going*; Budi going, then cancelled |
 * | *Kickoff 2026* | in 14 days | all | none: Rina's *Upcoming*, *Join event* |
 * | *Rapat leader* | **running**: `configure()` dates it from an hour before the run to six hours after | leaders | Agus and Sari going; Dewi (leads nobody) and Rina do not see it |
 * | *Briefing PRULink* | 21 days ago | company · all | Rina going, no answer → *Feedback pending*; Budi going, confirmed, 9; Indah said she came, **unconfirmed**, 6; Dimas going, **marked absent**; Siti nothing → NPS 100 over one confirmed answer, *"· 1 awaiting attendance confirmation"* |
 * | *Town Hall {bulan}* *(new; `KPM_Owner.html:1655`, `:2984`)* | 35 days ago | all | **Eight confirmed answers with the prototype's scores and words, in Bahasa Indonesia** (`KPM_Owner.html:2990-2998`) — the Owner's 10, confirmed by the Admin; Agus 9, Indah 9, Sari 8, Siti 7, Dimas 6, Novi 5, Dewi 4 → *NPS 0 · 8 responses*, as drawn; Rina nothing → *Didn't join*, *I actually attended this event* |
 * | *Bootcamp Agen Baru* *(new)* | 50 days ago | chosen agents: Rina, Budi, Yanti's first membership | Rina going, 9 with *Why* → the thanks block; Yanti's first membership confirmed with an answer, kept with it; her second membership does not see the event |
 * | *Klinik penjualan* *(new)* | 10 days ago | all | nothing → the empty roll call, *—* and *"No feedback yet."* |
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `rina@kpm0417.test` | `/events`: *Going* (Product refresh), *Upcoming* (Kickoff), *Feedback pending* (PRULink, the form), *Didn't join* (Town Hall, Sales clinic), *Feedback sent* (Bootcamp, the thanks); no *Rapat leader* |
 * | `budi@kpm0417.test` | The cancelled RSVP on Product refresh — *Not joined*, *Join event* |
 * | `agus@` · `sari@` | *Rapat leader* among *Going*; `GET /kpm/settings/events` answered 403 |
 * | `dewi@` | No *Rapat leader* |
 * | `owner@` · `admin@` | `/kpm/settings/events` › *View feedback*: the Town Hall at *NPS 0 · 8 responses*; PRULink with one awaiting and one absent; the Owner's own row disabled for the Owner, confirmable by the Admin; *Klinik penjualan* empty |
 * | `removed@kpm0417.test` (Yanti) | Her current membership does not see the Bootcamp; her first membership's rows stay |
 *
 * **Derived ids, written once until `--reset`**: an event, a row or an answer already there is left as it is, so a
 * re-run writes nothing and a walk's own RSVPs, claims, confirmations and answers are kept. The seed's inbox reminders
 * of the three `configure()` events are untouched (nothing sends `EVENT_REMINDER`; the phase file, *Found while
 * preparing* 5).
 */

/**
 * **The words the office and its members typed** — in Bahasa Indonesia since P18.10-T7 (OD-238): the demo reads as an
 * Indonesian office. Every row is keyed by code or by its derived id, never by what it says, so a database seeded
 * before keeps its English and gets no second row.
 */

/** The three events `configure()` writes for every office (`demo.ts`), by code. */
export const CONFIGURED_EVENTS = {
  KICKOFF: { title: 'Kickoff 2026', blurb: 'Gambaran tahun ini, dan apa saja yang menjadi ukuran kita.' },
  LEADERS_HUDDLE: { title: 'Rapat leader', blurb: 'Angka tiap unit, dan siapa yang perlu dibantu bulan ini.' },
  PRULINK_BRIEFING: { title: 'Briefing PRULink', blurb: 'Rider baru, dan cara menawarkannya.' },
} as const;

/** The titles of the four events this fixture adds; the Town Hall's names its month, in Indonesian. */
export const EVENTS_FIXTURE_TITLES = {
  PRODUCT_REFRESH: 'Briefing pembaruan produk',
  townHall: (month: string) => `Town Hall ${month}`,
  NEW_AGENT_BOOTCAMP: 'Bootcamp Agen Baru',
  SALES_CLINIC: 'Klinik penjualan',
} as const;

/** The Town Hall's eight answers, the prototype's scores and sense (`KPM_Owner.html:2990-2998`), in its order. */
export const TOWN_HALL_ANSWERS: readonly [score: number, why: string, improve: string][] = [
  [10, 'Energinya luar biasa — segmen apresiasinya benar-benar mengena.', 'Perbanyak momen apresiasi — ulangi format ini.'],
  [9, 'Suka sesi tanya jawab langsungnya, terasa sangat terbuka.', 'Jadikan tanya jawab langsung segmen tetap.'],
  [9, 'Town hall terbaik sejauh ini — prioritas Q3 sangat jelas.', 'Tetap buka dengan prioritas kuartal yang jelas.'],
  [8, 'Update-nya solid, tapi waktu tanya jawabnya kurang.', 'Tambah waktu tanya jawab 10–15 menit.'],
  [7, 'Materinya bagus, tapi audionya putus dua kali.', 'Tes mic dan perangkat AV sebelum mulai.'],
  [6, 'Agak kelamaan, energinya turun menjelang akhir.', 'Pangkas agendanya — selesai selagi energi masih tinggi.'],
  [5, 'Terlalu lama — bisa lebih dipadatkan.', 'Potong 15–20 menit dari total durasi.'],
  [4, 'Terasa mengulang town hall kuartal lalu.', 'Segarkan materinya — jangan mengulang slide kuartal lalu.'],
];

/** The other answers members typed, by event and who. */
export const EVENT_ANSWERS = {
  budiPrulink: [9, 'Jadi jelas cara menawarkan rider-nya.', ''],
  indahPrulink: [6, 'Bermanfaat, tapi panggilannya putus dua kali.', 'Kirim slide-nya sebelum panggilan dimulai.'],
  rinaBootcamp: [9, 'Jelas dan praktis — saya pulang dengan rencana untuk 30 hari pertama.', ''],
  yantiBootcamp: [8, 'Temponya pas, banyak yang perlu dicerna.', 'Ringkasan satu halaman untuk dibawa pulang.'],
} as const satisfies Record<string, readonly [number, string, string]>;

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
  const monthName = new Intl.DateTimeFormat('id-ID', { month: 'long', timeZone: timezone }).format(townHallStart);
  const drafts: Record<keyof typeof NEW_EVENTS, Record<string, unknown>> = {
    PRODUCT_REFRESH: {
      typeCode: 'PRODUCT_LAUNCH', title: EVENTS_FIXTURE_TITLES.PRODUCT_REFRESH,
      blurb: 'Rider dan harga terbaru menjelang peluncuran berikutnya.',
      description: 'Pembahasan rider produk yang diperbarui, tabel harga yang direvisi, dan poin-poin pembicaraan untuk klien.',
      location: 'Online — Zoom', locationUrl: 'https://meet.example.test/product-refresh',
      audience: { issuer: 'company', scope: 'all_agents', inviteeMembershipIds: [] },
    },
    TOWN_HALL: {
      typeCode: 'COMMUNITY', title: EVENTS_FIXTURE_TITLES.townHall(monthName),
      blurb: 'Capaian kuartal ini, apresiasi, dan sesi tanya jawab terbuka.',
      description: 'Seluruh kantor berkumpul: posisi kita kuartal ini, siapa yang kita apresiasi, dan tanya jawab terbuka bersama Owner.',
      location: 'Kantor KPM, Ruang serbaguna', locationUrl: null,
      audience: { issuer: 'kpm', scope: 'all_agents', inviteeMembershipIds: [] },
    },
    NEW_AGENT_BOOTCAMP: {
      typeCode: 'TRAINING', title: EVENTS_FIXTURE_TITLES.NEW_AGENT_BOOTCAMP,
      blurb: 'Sehari pembekalan untuk agen yang baru terdaftar.',
      description: 'Dasar-dasar produk, kepatuhan, dan target aktivitas 30 hari pertama untuk agen yang baru terdaftar.',
      location: 'Kantor KPM, Ruang pelatihan', locationUrl: null,
      audience: { issuer: 'kpm', scope: 'select_agents', inviteeMembershipIds: [cast.rina, cast.budi, cast.yantiFirst] },
    },
    SALES_CLINIC: {
      typeCode: 'TRAINING', title: EVENTS_FIXTURE_TITLES.SALES_CLINIC,
      blurb: 'Bawa satu case yang sedang macet.',
      description: 'Sesi kerja: setiap agen membawa satu prospek yang sedang macet, lalu dibahas bersama.',
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
      budi: { rsvp: 'going', confirmed: { attended: true, by: 'owner' }, answer: [...EVENT_ANSWERS.budiPrulink] },
      indah: { claimed: true, answer: [...EVENT_ANSWERS.indahPrulink] },
      dimas: { rsvp: 'going', confirmed: { attended: false, by: 'owner' } },
    },
    TOWN_HALL: Object.fromEntries(TOWN_HALL_CAST.map((who, i) => [who, {
      rsvp: 'going',
      // Nobody confirms their own: the Admin confirms the Owner, the Owner everybody else.
      confirmed: { attended: true, by: who === 'owner' ? 'admin' : 'owner' },
      answer: TOWN_HALL_ANSWERS[i],
    } satisfies RsvpPlan])),
    NEW_AGENT_BOOTCAMP: {
      rina: { rsvp: 'going', answer: [...EVENT_ANSWERS.rinaBootcamp] },
      yantiFirst: {
        rsvp: 'going', confirmed: { attended: true, by: 'owner' },
        answer: [...EVENT_ANSWERS.yantiBootcamp],
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
  // Each event by the title the office holds: a database seeded before P18.10-T7 keeps its English ones.
  const titleOf = async (code: string) => String((await db.collection('events').findOne({ _id: oid(ids[code]) }))!.title);
  const [refresh, kickoff, huddle, prulink, bootcamp, clinic] = await Promise.all(
    ['PRODUCT_REFRESH', 'KICKOFF', 'LEADERS_HUDDLE', 'PRULINK_BRIEFING', 'NEW_AGENT_BOOTCAMP', 'SALES_CLINIC'].map(titleOf),
  );
  const guide = `
  EVENTS at /events and /kpm/settings/events  (from src/seed/events-fixture.ts)
    rina@kpm0417.test            /events: Going (${refresh}), Upcoming (${kickoff}), Feedback
                                 pending (${prulink}: the form), Didn't join (${townHall}, ${clinic}:
                                 "I actually attended this event"), Feedback sent (${bootcamp}: the
                                 thanks). No ${huddle}
    budi@kpm0417.test            ${refresh} RSVP cancelled: Not joined, Join event
    agus@ · sari@kpm0417.test    ${huddle} among Going; GET /kpm/settings/events answered 403
    dewi@kpm0417.test            leads nobody: no ${huddle}
    owner@ · admin@kpm0417.test  Settings › Events › View feedback on a past row: ${townHall} at NPS 0 ·
                                 8 responses (the Owner's own row disabled for the Owner, confirmable by
                                 the Admin); ${prulink} with one awaiting confirmation and one marked absent;
                                 ${clinic} empty — "No feedback yet."
    removed@kpm0417.test         Yanti's current membership does not see the ${bootcamp}; her first
                                 membership's confirmed answer stays with it
`;
  return { written, events: ids, guide };
}
