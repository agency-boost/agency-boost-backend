import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **The Personal Summary's leads, for the AB demo login** (P19.11-T5; UX-13; `functional/summary.md`, *Seed*): the
 * section *Leads yang perlu perhatian Anda* draws the shared lead card, the **top 5** of every open lead, what needs
 * attention first, and ***Lihat semua (N)*** for the rest. `agus@kpm0417.test` holds open leads from other fixtures —
 * *Ibu Ratna Wulandari* due on the run's day and *Pak Yusuf Hidayat* ticked (`home-fixture.ts`), three this week
 * (`tugas-fixture.ts`), two with proposals (`proposal-fixture.ts`) — and none of them is late on the day the seed runs
 * if that day is a Monday. These two make the order reviewable whatever the day:
 *
 * | Lead | Next action | Where it sorts |
 * |---|---|---|
 * | *Pak Adrianus Simatupang* | **three days before the run** — *Tanyakan keputusan soal ilustrasi.* | first: the most overdue |
 * | *Ibu Kirana Maheswari* | none, no remarks — the card's red *Isi tindakan* | first of the undated: registered longest ago |
 *
 * So the section holds more than five, *Lihat semua (N)* shows, and the dated, the overdue and the undated are all
 * there. Open sales leads, **none switched on for the month**, so the Potensi tab and the roster's commitments stay as
 * their own seeds pin them (a lead closing this month wears its badge on Rina's Summary, `demo.ts`' Phase 7 leads).
 * **Written once, until `--reset`**: each `_id` is derived (`seedObjectId`), and a later run keeps the day it was
 * written for, as every fixture's dates are kept.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** The two leads: a name no member of the office has, and no other lead has. */
export const SUMMARY_LEADS = [
  {
    key: 'agus-overdue', name: 'Pak Adrianus Simatupang', stage: 'FOLLOW_UP', registeredDaysAgo: 21,
    nextActionIn: -3, nextActionNote: 'Tanyakan keputusan soal ilustrasi.', phone: '+6281355503579',
    remarks: 'Pemilik bengkel; membandingkan dua produk proteksi.',
  },
  {
    key: 'agus-undated', name: 'Ibu Kirana Maheswari', stage: 'NOT_YET_APPROACHED', registeredDaysAgo: 45,
    nextActionIn: null, nextActionNote: null, phone: null, remarks: null,
  },
] as const;

export const summaryLeadId = (kpmId: string, key: string) => seedObjectId('summary-leads-fixture', 'lead', kpmId, key);

export interface SummaryLeadsFixtureDeps {
  clock: Clock;
  kpm0417: string;
  agus: string;
}

export async function seedSummaryLeadsFixture(deps: SummaryLeadsFixtureDeps): Promise<{ written: number; guide: string }> {
  const { clock, kpm0417: kpmId, agus } = deps;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);

  let written = 0;
  for (const seed of SUMMARY_LEADS) {
    const id = summaryLeadId(kpmId, seed.key);
    if (await Leads.exists({ _id: new mongoose.Types.ObjectId(id) }).exec()) continue;
    const status = await LeadStatuses.findOne({ kpmId, code: seed.stage }).lean().exec();
    const registered = new Date(now.getTime() - seed.registeredDaysAgo * DAY_MS);
    await Leads.create({
      _id: new mongoose.Types.ObjectId(id),
      kpmId, ownerMembershipId: agus, name: seed.name, type: 'sales',
      contact: { phone: seed.phone, email: null },
      statusCode: seed.stage, statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [], remarks: seed.remarks,
      nextActionDate: seed.nextActionIn === null ? null : addDays(today, seed.nextActionIn),
      nextActionNote: seed.nextActionNote,
      outcome: null, outcomeAt: null, dateRegistered: registered, source: 'Jaringan pribadi', joinedMembershipId: null,
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: seed.stage, at: registered, byMembershipId: agus }],
      deletedAt: null, createdBy: agus, updatedBy: agus,
    });
    written += 1;
  }

  const guide = `
  SUMMARY LEADS at /summary  (from src/seed/summary-leads-fixture.ts)
    agus@kpm0417.test            Leads yang perlu perhatian Anda: the shared lead cards, the top 5 — ${SUMMARY_LEADS[0].name}
                                 first (three days late on the seed's day), then the dated, then the undated,
                                 ${SUMMARY_LEADS[1].name} first among them; Lihat semua (N) opens the rest in
                                 place, Tampilkan lebih sedikit closes it. Tap a card: the lead sheet over the page
    rina@kpm0417.test            the same section, with the Potensi badge on the leads closing this month
`;
  return { written, guide };
}
