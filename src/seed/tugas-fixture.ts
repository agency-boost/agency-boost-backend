import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { mondayOf } from '@/modules/calendar/calendar-time';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **This week's *Tugas*, anchored to Monday** (P19.1-T3 AC-12; UI-154; `functional/calendar.md`, *November 2026*): the
 * Calendar's *Tugas* are a member's own open leads' next actions and their newest 1:1's open items. Those seeded so far
 * are dated from the run's *today*, so which days of this week hold one depended on the weekday the seed ran. These
 * leads' next actions are dated from **this week's Monday** in the office's zone, so several days of the current week
 * hold a *Tugas* whatever day the seed runs — Agus's on Monday, Tuesday and Thursday, Rina's on Monday, Wednesday and
 * Friday — and Sunday holds none of these.
 *
 * | Owner | Lead | Next action |
 * |---|---|---|
 * | Agus | *Pak Hendri Wibisono* | Monday — *Telepon untuk jadwal presentasi.* |
 * | Agus | *Ibu Larasati Putri* | Tuesday — *Kirim ilustrasi dana pendidikan.* |
 * | Agus | *Ibu Wening Pratiwi* | Thursday — *Ketemu di kantornya, jam 14.00.* |
 * | Rina | *Ibu Shinta Wardhani* | Monday — *Konfirmasi jadwal ketemu.* |
 * | Rina | *Pak Gunawan Saleh* | Wednesday — *Bawa brosur proteksi keluarga.* |
 * | Rina | *Ibu Wening Sari* | Friday — *Follow up soal premi bulanan.* |
 *
 * Open sales leads at *Follow-up*, none switched on for the month, so the *Potensi* tab and the roster's commitments are
 * as their own seeds pin them. **Written once, until `--reset`**: each `_id` is derived (`seedObjectId`); a later run
 * keeps the week they were written for, as every fixture's dates are kept.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

export interface TugasFixtureDeps {
  clock: Clock;
  kpm0417: string;
  agus: string;
  rina: string;
}

/** Each lead: whose, the days after this week's Monday its next action falls on, and its words. */
export const TUGAS_LEADS = [
  { key: 'agus-mon', owner: 'agus', name: 'Pak Hendri Wibisono', offset: 0, note: 'Telepon untuk jadwal presentasi.' },
  { key: 'agus-tue', owner: 'agus', name: 'Ibu Larasati Putri', offset: 1, note: 'Kirim ilustrasi dana pendidikan.' },
  { key: 'agus-thu', owner: 'agus', name: 'Ibu Wening Pratiwi', offset: 3, note: 'Ketemu di kantornya, jam 14.00.' },
  { key: 'rina-mon', owner: 'rina', name: 'Ibu Shinta Wardhani', offset: 0, note: 'Konfirmasi jadwal ketemu.' },
  { key: 'rina-wed', owner: 'rina', name: 'Pak Gunawan Saleh', offset: 2, note: 'Bawa brosur proteksi keluarga.' },
  { key: 'rina-fri', owner: 'rina', name: 'Ibu Wening Sari', offset: 4, note: 'Follow up soal premi bulanan.' },
] as const;

export const tugasLeadId = (kpmId: string, key: string) => seedObjectId('tugas-fixture', 'lead', kpmId, key);

export async function seedTugasFixture(deps: TugasFixtureDeps): Promise<{ written: number; guide: string }> {
  const { clock, kpm0417: kpmId } = deps;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const now = clock.now();
  const monday = mondayOf(clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now));
  const status = await LeadStatuses.findOne({ kpmId, code: 'FOLLOW_UP' }).lean().exec();
  const registered = new Date(now.getTime() - 14 * DAY_MS);

  let written = 0;
  for (const seed of TUGAS_LEADS) {
    const id = tugasLeadId(kpmId, seed.key);
    if (await Leads.exists({ _id: new mongoose.Types.ObjectId(id) }).exec()) continue;
    const owner = seed.owner === 'agus' ? deps.agus : deps.rina;
    await Leads.create({
      _id: new mongoose.Types.ObjectId(id),
      kpmId, ownerMembershipId: owner, name: seed.name, type: 'sales',
      contact: { phone: null, email: null },
      statusCode: 'FOLLOW_UP', statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [], remarks: 'Ketemu di acara komunitas; tertarik proteksi keluarga.',
      nextActionDate: addDays(monday, seed.offset), nextActionNote: seed.note,
      outcome: null, outcomeAt: null, dateRegistered: registered, source: 'Jaringan pribadi', joinedMembershipId: null,
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: 'FOLLOW_UP', at: registered, byMembershipId: owner }],
      deletedAt: null, createdBy: owner, updatedBy: owner,
    });
    written += 1;
  }

  const guide = `
  TUGAS THIS WEEK at /calendar  (from src/seed/tugas-fixture.ts)
    agus@kpm0417.test            lead next actions on Monday, Tuesday and Thursday of the week the seed ran
    rina@kpm0417.test            lead next actions on Monday, Wednesday and Friday of the week the seed ran
`;
  return { written, guide };
}
