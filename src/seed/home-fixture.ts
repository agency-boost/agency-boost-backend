import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **Home, as the 7 November review draws it** (P19.8-T2 AC-11; ADR-0228; `functional/home.md`, *Seed*). Most of what
 * Home shows is seeded already; this adds the one row it lacked and says where the rest comes from.
 *
 * | Account | Home shows |
 * |---|---|
 * | `agus@kpm0417.test` (AB) | ***Aksi hari ini***, **today's alone** (P19.11-T1): *Ibu Ratna Wulandari*'s next action **on the run's today** (this file) and *Pak Yusuf Hidayat*'s, **already ticked** — the Calendar's task rows, the second struck through — then today's first timed thing still to come, the Agenda's row: the *Rapat leader* event he joined (`events-fixture.ts`), with its calendar icon, which opens the event; his 1:1 with Indah at 13:00 (`calendar-fixture.ts`) is next in the Calendar and opens its detail over Home with *Hapus · Ubah · Tutup*. ***Laporan aktivitas tim***: his Group reported both days (`coaching-cast.ts`), **Budi** neither (nine days ago) and **Dewi** a saved day of zeroes yesterday, so a grey ✕ beside orange counts; **the day after the run**, everybody who logged on it reads *Kmrn n* and a ✕ today. More than five, so *Semua ›*. ***Leads***: his own open leads. ***New hires***: his Group's before a first sale |
 * | `dewi@kpm0417.test` (AAB, nobody) | Six tiles: *Active Agent* and *Coaching 7 hari* at *0 dari –*, *Leads 0*, *New hires 0*; *Tambah agent pertama →* in *Laporan aktivitas tim* |
 * | `rina@kpm0417.test`, `budi@kpm0417.test` (Agents) | *Aktivitas saya*, *Jadwal hari ini*, then *Leads* across the row — no New Hires in their menu; *Buat proposal* alone |
 *
 * **An Agent whose menu has New Hires is not seeded**: New Hires reaches an Agent who coaches a new hire, which takes a
 * direct report, and the activation fixture leaves that case to a test fixture so the coaching and calendar demos stay as
 * reviewed (`activation-fixture.ts`). Such an Agent is a leader by the menu (ADR-0189 §1), so their Home is the leader's.
 *
 * **Written once, until `--reset`**: the lead's `_id` is derived (`seedObjectId`) and its day is the run's, so a later run
 * keeps the day it was written for, as every fixture's dates are kept.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** The client: a name no member of the office has (`calendar-fixture.ts`, *Clients take names no member has*). */
export const HOME_TODAY_LEAD = {
  key: 'agus-today',
  name: 'Ibu Ratna Wulandari',
  note: 'Telepon untuk konfirmasi jadwal presentasi.',
} as const;

/**
 * **A task Agus already ticked today** (P19.11-T1 AC-1, AC-3; UX-1, UX-2): its next action moved into `nextActionDone`,
 * as the Calendar's checkbox leaves it — so *Aksi hari ini* and this week's Calendar draw a completed task, struck
 * through, beside the open one, and *Tugas · n* counts the open one alone. Its name sorts after Ratna's, so the open task
 * leads the list.
 */
export const HOME_TICKED_LEAD = {
  key: 'agus-ticked-today',
  name: 'Pak Yusuf Hidayat',
  note: 'Kirim ringkasan manfaat lewat WhatsApp.',
} as const;

export const homeLeadId = (kpmId: string, key: string) => seedObjectId('home-fixture', 'lead', kpmId, key);

export interface HomeFixtureDeps {
  clock: Clock;
  kpm0417: string;
  agus: string;
}

export async function seedHomeFixture(deps: HomeFixtureDeps): Promise<{ written: number; guide: string }> {
  const { clock, kpm0417: kpmId, agus } = deps;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);
  const id = homeLeadId(kpmId, HOME_TODAY_LEAD.key);

  let written = 0;
  if (!(await Leads.exists({ _id: new mongoose.Types.ObjectId(id) }).exec())) {
    const status = await LeadStatuses.findOne({ kpmId, code: 'FOLLOW_UP' }).lean().exec();
    const registered = new Date(now.getTime() - 10 * DAY_MS);
    await Leads.create({
      _id: new mongoose.Types.ObjectId(id),
      kpmId, ownerMembershipId: agus, name: HOME_TODAY_LEAD.name, type: 'sales',
      contact: { phone: '+6281355501234', email: null },
      statusCode: 'FOLLOW_UP', statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [], remarks: 'Kenalan dari arisan kompleks; tertarik dana pendidikan.',
      nextActionDate: today, nextActionNote: HOME_TODAY_LEAD.note,
      outcome: null, outcomeAt: null, dateRegistered: registered, source: 'Jaringan pribadi', joinedMembershipId: null,
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: 'FOLLOW_UP', at: registered, byMembershipId: agus }],
      deletedAt: null, createdBy: agus, updatedBy: agus,
    });
    written += 1;
  }

  // P19.11-T1: the ticked one — its date and note where a tick puts them, the lead asking for a new next action.
  const tickedId = homeLeadId(kpmId, HOME_TICKED_LEAD.key);
  if (!(await Leads.exists({ _id: new mongoose.Types.ObjectId(tickedId) }).exec())) {
    const status = await LeadStatuses.findOne({ kpmId, code: 'FOLLOW_UP' }).lean().exec();
    const registered = new Date(now.getTime() - 12 * DAY_MS);
    await Leads.create({
      _id: new mongoose.Types.ObjectId(tickedId),
      kpmId, ownerMembershipId: agus, name: HOME_TICKED_LEAD.name, type: 'sales',
      contact: { phone: '+6281355507788', email: null },
      statusCode: 'FOLLOW_UP', statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [], remarks: 'Rekan kerja istri; tanya soal proteksi kesehatan.',
      nextActionDate: null, nextActionNote: null,
      nextActionDone: { date: today, note: HOME_TICKED_LEAD.note, at: now, byMembershipId: agus },
      outcome: null, outcomeAt: null, dateRegistered: registered, source: 'Jaringan pribadi', joinedMembershipId: null,
      version: 3, transitions: [{ fromStatusCode: null, toStatusCode: 'FOLLOW_UP', at: registered, byMembershipId: agus }],
      deletedAt: null, createdBy: agus, updatedBy: agus,
    });
    written += 1;
  }

  const guide = `
  HOME at /home  (from src/seed/home-fixture.ts)
    agus@kpm0417.test            Aksi hari ini (today's alone): ${HOME_TODAY_LEAD.name}'s next action on the day
                                 the seed ran, ${HOME_TICKED_LEAD.name}'s already ticked (struck through; untick
                                 it), then today's first timed thing still to come (the Rapat leader event he
                                 joined). His 1:1 with Indah at 13:00 is on /calendar today — tap it there or from
                                 Home after the event: the detail opens over Home, Hapus asks first. Laporan aktivitas tim: orange counts, a grey ✕ for Budi and Dewi;
                                 the day after the seed, yesterday's counts and today's ✕. Semua › opens
                                 the Unit Dashboard's Aktivitas
    dewi@kpm0417.test            the six tiles at 0 (0 dari – on the leader tiles); Tambah agent pertama →
    rina@kpm0417.test            an Agent: Leads across the row, Buat proposal alone
`;
  return { written, guide };
}
