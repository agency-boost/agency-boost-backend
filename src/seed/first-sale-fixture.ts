/**
 * **The first sale and the data-backed checklist items, seeded** (P18.8-T4; ADR-0171 §1, §3;
 * `functional/activation.md`, *Data-backed items — Seed*). Defined here, inserted by `demo.ts`; every row's `_id` is
 * derived (`seedObjectId`), so a re-run writes nothing and a row a walk changed is never written over.
 *
 * Each person's `firstSaleDate` is then **computed, never typed**: `demo.ts` runs migration 0042's backfill over the
 * finished seed — the same `firstSaleOf` the leads and the production file's writes call — so a fresh seed and a
 * migrated database say the same thing, and every link reads the records a walk can open.
 *
 * | Account | What it shows |
 * |---|---|
 * | `dimas@kpm0417.test` (Agus) | *Close first case independently* **ticks itself** on the first read, *"Completed from Sales data · 1 {last month}"* — his first sale is the production file's last month, `monthly_file`, his existing closing (AC-5). His leads hold none at *Paid and issued* |
 * | `novi@kpm0417.test` (Arief) | **A first sale on day 20**: *Ibu Sekar Ayuningtyas*, a sales lead walked to *Paid and issued* 19 days after her join date and won — her first sale `lead`, day 20; *Close first case independently* completes from it, naming the lead. For T6's *activated* |
 * | `raka@kpm0417.test` (Satria) | **His only sale on day 120**: *Pak Darto Wibisono*, paid and issued 119 days after he joined, and no policy on any file — his first sale `lead`, day 120. His activation graduated long ago (`cohort-fixture.ts`), so no checklist moves; the date is for T6's *not activated* — since UI V1 *Teraktivasi* in amber, outside the 3M rate |
 * | `rina@kpm0417.test` (Sari) | **Four 1:1s**: a fourth session with Sari three weeks ago, before the cohort fixture's three weekly ones, so *Weekly 1-on-1 check-in* completes from the fourth — today's — *"Completed from Coaching sessions · {today}"*. Her leads reach *Paid and issued* too, so her first case and her milestone tick from her sales |
 * | `indah@kpm0417.test` (Agus) | **Waiting for data**: Agus's hand tick of *Weekly 1-on-1 check-in* (`activation-fixture.ts`) reads *"Ticked by Agus Prasetyo, waiting for data"* — she has one 1:1 since joining, not four. Her own tick of *Close first case independently* switches to the production file's month on the first read |
 */
import { addDays, type LocalDate } from '@/common/time/local-day';
import type { Clock } from '@/common/clock/clock.port';
import { FIRST_SALE_STAGE_CODE } from '@/domain/constants';
import { seedObjectId } from './coaching-fixture';

/** The sales ladder a closing here walks, as the leads flow takes one: approached, submitted, paid and issued. */
const WALK = ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', FIRST_SALE_STAGE_CODE] as const;

export interface FirstSaleFixtureInput {
  clock: Clock;
  timezone: string;
  kpmId: string;
  members: { novi: string; raka: string; rina: string; sari: string };
  /** Each one's join date, an office date, as the seed gave it. */
  joined: { novi: LocalDate; raka: LocalDate };
}

/** A sales lead, by `erd.md`'s names, walked to *Paid and issued* and won there. */
export interface FirstSaleLeadSeed {
  _id: string;
  kpmId: string;
  ownerMembershipId: string;
  type: 'sales';
  name: string;
  contact: { phone: string | null; email: string | null };
  statusCode: string;
  statusId: string | null;
  commitments: never[];
  remarks: string;
  nextActionDate: null;
  nextActionNote: null;
  outcome: 'won';
  outcomeAt: Date;
  dateRegistered: Date;
  source: string;
  loggedFrom: null;
  version: number;
  transitions: { fromStatusCode: string | null; toStatusCode: string; at: Date; byMembershipId: string }[];
  deletedAt: null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A finalized 1:1, by `erd.md`'s names, as the workspace finalizes one. Its snapshot is taken by `demo.ts`. */
export interface FirstSaleSessionSeed {
  _id: string;
  kpmId: string;
  coachMembershipId: string;
  coacheeMembershipId: string;
  status: 'finalized';
  date: LocalDate;
  lastWeek: null;
  lastWeekItems: never[];
  actionItems: { itemId: string; text: string; dueDate: LocalDate; carriedFromItemId: null }[];
  tips: { tipId: string; text: string; carriedFromTipId: null }[];
  leadActions: never[];
  snapshot: null;
  finalizedAt: Date;
  finalizedByMembershipId: string;
  version: number;
  frozenAt: Date;
  corrections: never[];
  deletedAt: null;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FirstSaleFixture {
  leads: FirstSaleLeadSeed[];
  sessions: FirstSaleSessionSeed[];
  guide: string;
}

export function buildFirstSaleFixture(input: FirstSaleFixtureInput): FirstSaleFixture {
  const { clock, timezone, kpmId, members } = input;
  const today = clock.localDateFor(timezone);
  const now = clock.now();
  /** 11:00 office time on a day; never later than the run. */
  const at = (date: LocalDate): Date => {
    const eleven = new Date(clock.startOfLocalDay(timezone, date).getTime() + 11 * 3_600_000);
    return eleven < now ? eleven : now;
  };

  const lead = (
    owner: string, name: string, registered: LocalDate, closed: LocalDate, remarks: string, source: string,
  ): FirstSaleLeadSeed => {
    const steps = [registered, addDays(registered, 3), closed];
    return {
      _id: seedObjectId('first-sale-fixture', 'lead', kpmId, owner, name),
      kpmId, ownerMembershipId: owner, type: 'sales', name,
      contact: { phone: null, email: null },
      statusCode: FIRST_SALE_STAGE_CODE, statusId: null,
      commitments: [], remarks, nextActionDate: null, nextActionNote: null,
      // Won when it was paid and issued, so it is a closed case in no open count, then or since.
      outcome: 'won', outcomeAt: at(closed),
      dateRegistered: at(registered), source, loggedFrom: null,
      version: 1 + WALK.length + 1,
      transitions: WALK.map((code, i) => ({
        fromStatusCode: i === 0 ? null : WALK[i - 1], toStatusCode: code, at: at(steps[i]), byMembershipId: owner,
      })),
      deletedAt: null, createdBy: owner, updatedBy: owner, createdAt: at(registered), updatedAt: at(closed),
    };
  };

  // Day 1 is the join date: day 20 is 19 days after it, day 120 is 119.
  const noviClosed = addDays(input.joined.novi, 19);
  const rakaClosed = addDays(input.joined.raka, 119);
  const leads = [
    lead(members.novi, 'Ibu Sekar Ayuningtyas', addDays(input.joined.novi, 8), noviClosed,
      'Dana pendidikan untuk putrinya. Sudah lunas.', 'Referral — Arief'),
    lead(members.raka, 'Pak Darto Wibisono', addDays(input.joined.raka, 104), rakaClosed,
      'Asuransi berjangka, premi tahunan. Case pertamanya, setelah berbulan-bulan.', 'Canvassing — BSD'),
  ].filter((row) => row.transitions.every((t) => t.at <= now));

  // Rina's fourth 1:1: three weeks back, before the three weekly ones the coaching fixture holds.
  const rinaDate = addDays(today, -21);
  const sessions: FirstSaleSessionSeed[] = [{
    _id: seedObjectId('first-sale-fixture', 'session', kpmId, members.sari, members.rina, 'fourth'),
    kpmId, coachMembershipId: members.sari, coacheeMembershipId: members.rina, status: 'finalized', date: rinaDate,
    lastWeek: null, lastWeekItems: [],
    actionItems: [{
      itemId: seedObjectId('first-sale-fixture', 'item', members.rina, 'fourth'), text: 'Tulis sepuluh nama untuk daftar prospek',
      dueDate: addDays(rinaDate, 7), carriedFromItemId: null,
    }],
    tips: [{ tipId: seedObjectId('first-sale-fixture', 'tip', members.rina, 'fourth'), text: 'Jadwalkan teleponnya sebelum jam 12 siang.', carriedFromTipId: null }],
    leadActions: [], snapshot: null,
    finalizedAt: at(rinaDate), finalizedByMembershipId: members.sari, version: 3, frozenAt: at(rinaDate), corrections: [],
    deletedAt: null, createdBy: members.sari, updatedBy: members.sari, createdAt: at(rinaDate), updatedAt: at(rinaDate),
  }];

  const guide = [
    'FIRST SALE and the data-backed checklist items (P18.8-T4; ADR-0171)',
    '  dimas@kpm0417.test   Closing case pertama secara mandiri ticks from the production file: Completed from Sales data',
    `  novi@kpm0417.test    first sale on day 20 (${noviClosed}), Ibu Sekar Ayuningtyas, paid and issued`,
    `  raka@kpm0417.test    only sale on day 120 (${rakaClosed}), Pak Darto Wibisono — Teraktivasi late, outside the 3M rate`,
    `  rina@kpm0417.test    four 1:1s (the fourth today): Check-in 1-on-1 mingguan Completed from Coaching sessions`,
    '  indah@kpm0417.test   Check-in 1-on-1 mingguan: Ticked by Agus Prasetyo, waiting for data',
  ].join('\n');

  return { leads, sessions, guide };
}
