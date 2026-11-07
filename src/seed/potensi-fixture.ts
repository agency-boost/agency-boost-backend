import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **The *Potensi* switch and tab, seeded** (P19.1-T2 AC-14, P19.1-T6 AC-13; UI-153, UI-155; ADR-0193,
 * `functional/unit-dashboard.md` and `functional/leads.md`, *November 2026*).
 *
 * Most of what the tab reads is seeded already: the coaching cast's leads switched on for the month
 * (`coaching-cast.ts`'s `thisMonth`), Rina's (`demo.ts`) — *Ibu Rosa Damayanti* and *Pak Hendro Gunawan* switched on,
 * *Ibu Wulan Sari* switched on **at the final stage, not yet marked** — Budi's recruitment lead *Pak Andi Kurniawan*
 * switched on (*Potensi rekrut bulan ini*; the Rekrut tile's *1 potensi*), and the month's production file, which
 * shows a policy for nearly everybody and leaves Budi and Yanti out. This adds only what nothing showed yet — and no
 * open lead, so Rina's dragged order and the roster's *Potential Recruits* stay as their own seeds pin them:
 *
 * | Owner | Lead | What it shows |
 * |---|---|---|
 * | Rina | *Ibu Melinda Sasmita*, sales, switched on, *Berhasil* this month | the **green ✓** on her list (T2 AC-8, AC-14) |
 * | Indah | *Sdri. Sinta Rahayu*, recruitment, switched on, *Berhasil* this month, linked to nobody | a **rekrut not yet added**: *Tambahkan ke unit ›* |
 * | Arief | *Sdr. Wahyu Saputra*, recruitment, *Berhasil* this month, linked to Wahyu's membership | a **rekrut linked**: *New Hires ›* opens Wahyu's page |
 * | Siti | *Ibu Purnama Sari*, sales, switched on **last month**, *Berhasil* last month | **last month's result**: *potensi 1/… · n AA* |
 * | Dimas | *Pak Rudy Hartono*, sales, switched on **last month**, still open | last month's *y*, a potensi that did not close |
 *
 * **Who sees what** on `agus@kpm0417.test`'s *Unit Dashboard → Potensi*: tile *AA* the people with a case this month
 * (the file's, and Rina's lead); Yanti **potensi only** (her *Pak Rahmat Sulistyo* switched on, no file this month);
 * Budi **✕** on *AA*; most of the cast **potensi and AA ✓**; Dewi **AA ✓ without the switch**. Tile *Rekrut*: Sinta and
 * Wahyu. `rina@kpm0417.test`'s `/leads`: yellow ✓ on Rosa, Hendro and Wulan, green ✓ on Lestari.
 *
 * **Written once, until `--reset`**: each `_id` is derived (`seedObjectId`), so a re-run writes nothing. Each date is
 * inside the month it is meant for, whatever day the seed runs: *this month's* case is no earlier than its 1st.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

export interface PotensiFixtureDeps {
  clock: Clock;
  kpm0417: string;
  rina: string;
  indah: string;
  arief: string;
  wahyu: string;
  siti: string;
  dimas: string;
}

export interface PotensiFixture {
  written: number;
  guide: string;
}

/** The derived id of each row this fixture writes. */
export const potensiLeadId = (kpmId: string, key: string) => seedObjectId('potensi-fixture', 'lead', kpmId, key);

/** The leads, by key: who owns them, and what they are. */
export const POTENSI_LEADS = {
  rinaGreen: { name: 'Ibu Melinda Sasmita', type: 'sales', stage: 'PAID_AND_ISSUED' },
  indahRekrut: { name: 'Sdri. Sinta Rahayu', type: 'recruitment', stage: 'NEW_ACTIVE_AGENT' },
  ariefRekrut: { name: 'Sdr. Wahyu Saputra', type: 'recruitment', stage: 'NEW_ACTIVE_AGENT' },
  sitiLastMonth: { name: 'Ibu Purnama Sari', type: 'sales', stage: 'PAID_AND_ISSUED' },
  dimasLastMonth: { name: 'Pak Rudy Hartono', type: 'sales', stage: 'FOLLOW_UP' },
} as const;

export async function seedPotensiFixture(deps: PotensiFixtureDeps): Promise<PotensiFixture> {
  const { clock, kpm0417: kpmId } = deps;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);
  const month = today.slice(0, 7);
  const lastMonth = addDays(`${month}-01`, -1).slice(0, 7);
  const thisStart = clock.monthBounds(DEFAULT_TENANT_TIMEZONE, month).start;
  const lastStart = clock.monthBounds(DEFAULT_TENANT_TIMEZONE, lastMonth).start;
  // This month's case: two days ago, or the 1st at midnight if the month is younger than that.
  const thisMonthCase = new Date(Math.max(thisStart.getTime(), now.getTime() - 2 * DAY_MS));
  const lastMonthCase = new Date(lastStart.getTime() + 12 * DAY_MS);
  const switchedOn = (m: string, by: string, at: Date) => [{ month: m, at, byMembershipId: by }];

  type Key = keyof typeof POTENSI_LEADS;
  const rows: { key: Key; owner: string; over: Record<string, unknown> }[] = [
    {
      key: 'rinaGreen', owner: deps.rina,
      over: { commitments: switchedOn(month, deps.rina, thisStart), outcome: 'won', outcomeAt: thisMonthCase, phone: '0812-5566-7788' },
    },
    {
      key: 'indahRekrut', owner: deps.indah,
      over: { commitments: switchedOn(month, deps.indah, thisStart), outcome: 'won', outcomeAt: thisMonthCase },
    },
    {
      key: 'ariefRekrut', owner: deps.arief,
      over: { outcome: 'won', outcomeAt: thisMonthCase, joinedMembershipId: deps.wahyu },
    },
    {
      key: 'sitiLastMonth', owner: deps.siti,
      over: { commitments: switchedOn(lastMonth, deps.siti, lastStart), outcome: 'won', outcomeAt: lastMonthCase },
    },
    {
      key: 'dimasLastMonth', owner: deps.dimas,
      over: {
        commitments: switchedOn(lastMonth, deps.dimas, lastStart), nextActionDate: addDays(today, 5),
        nextActionNote: 'Tanya lagi soal keputusan keluarganya.',
      },
    },
  ];

  let written = 0;
  for (const { key, owner, over } of rows) {
    const id = potensiLeadId(kpmId, key);
    if (await Leads.exists({ _id: new mongoose.Types.ObjectId(id) }).exec()) continue;
    const { name, type, stage } = POTENSI_LEADS[key];
    const status = await LeadStatuses.findOne({ kpmId, code: stage }).lean().exec();
    const registered = new Date(Math.min(lastStart.getTime(), now.getTime()) - 20 * DAY_MS);
    const { phone, ...rest } = over as { phone?: string } & Record<string, unknown>;
    await Leads.create({
      _id: new mongoose.Types.ObjectId(id),
      kpmId, ownerMembershipId: owner, name, type,
      contact: { phone: phone ?? null, email: null },
      statusCode: stage, statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [], remarks: null, nextActionDate: null, nextActionNote: null,
      outcome: null, outcomeAt: null, dateRegistered: registered, source: null, joinedMembershipId: null,
      version: 2, transitions: [{ fromStatusCode: null, toStatusCode: stage, at: (over.outcomeAt as Date | undefined) ?? registered, byMembershipId: owner }],
      deletedAt: null, createdBy: owner, updatedBy: owner,
      ...rest,
    });
    written += 1;
  }

  const guide = `
  POTENSI at /leads and /unit/dashboard?tab=potensi  (from src/seed/potensi-fixture.ts)
    rina@kpm0417.test            /leads: the yellow ✓ on Rosa, Hendro and Wulan (switched on this month), the
                                 green ✓ on Ibu Melinda Sasmita (switched on, marked Berhasil this month). Wulan
                                 is at the final stage: Tandai berhasil is on, Tandai tidak berhasil is off with
                                 "Polis sudah dibayar dan terbit"
    budi@kpm0417.test            /leads: Pak Andi Kurniawan, Potensi rekrut bulan ini
    agus@kpm0417.test            Unit Dashboard → Potensi: the Active Agent tile with its potensi x, units grouped
                                 (Unit Anda first, then Arief's, Dewi's, Sari's); Yanti's orange number (potensi
                                 only), Budi ✕, Dewi ✓ without the switch. Rekrut: Budi's potensi rekrut, Indah's
                                 Sdri. Sinta Rahayu (Tambahkan ke unit ›), Arief's Sdr. Wahyu Saputra (New Hires ›).
                                 Last month: Siti's case, Dimas's open potensi. An earlier month with none: the
                                 whole team, every row ✕ (P19.8-T4)
    rina@ · indah@kpm0417.test   Agents: no Potensi tab
`;
  return { written, guide };
}
