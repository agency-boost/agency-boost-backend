import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, FIRST_SALE_STAGE_CODE, mayTickByHand } from '@/domain/constants';
import type { ActivationItemState } from '@/modules/activation/activation-progress.schema';
import { ActivationProgress, ActivationProgressSchema } from '@/modules/activation/activation-progress.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { up as leadPosition } from '../migrations/0031-lead-position';
import { seedObjectId } from './coaching-fixture';
import { markNewHires } from './join-dates';

/**
 * **3M activation on `/new-hires`, seeded** (P18.8-T6; ADR-0171 §2, ADR-0173; amended by UI V1, UI-023, the owner's
 * D-24; `functional/activation.md`, *3M activation — Seed*): the two cases Agus's people had none of. Every other new
 * hire under him has a first sale — Indah's, Dimas's and Siti's on day 39 to 46, Rina's, Budi's, Novi's and Wahyu's
 * inside their 90 days, all ***Teraktivasi*** since UI V1 — but Yanti, inside her 90 days with none. So two new hires are
 * placed here, after every other 0417 member, so nobody's agent sequence moves:
 *
 * | Account | Who | What `/new-hires` shows |
 * |---|---|---|
 * | `lukman@kpm0417.test` | **Lukman Hakim**, Agus's own agent, joined 99 days ago (day 100) | ***Teraktivasi* in amber, *Pecah telor di hari ke-96***: his only sale, *Pak Hendra Kusnadi*, was paid and issued on **day 96** — after day 90, so his 3M result is *not activated* and **he is in neither part of the 3M share**. His checklist, 5 of 16 by his own ticks and his first case from the sale, is overdue |
 * | `tari@kpm0417.test` | **Tari Wulandari**, Arief's agent, joined 40 days ago | ***Belum*, *Hari ke-41***: Arief marked her left six days ago, on day 35, before any sale — kept as data (`leftAt`, its audit row), and **deciding nothing** since UI V1: no *Keluar*, and inside her 90 days she is in neither part of the share (Arief's 2 of 2, 100%, not 2 of 3). *Mark left* removed her from the office, so she is in no roster or count of people since, and Arief's and Agus's `/new-hires` still list her for her year |
 *
 * **Agus's *Aktivasi 3M* then reads 100%** — seven activated by day 90, nobody past day 90 without a sale, Lukman late
 * and Tari and Yanti inside their 90 days in neither part — and so do *Direct Unit* (3 of 3), **Arief's** (Wahyu and
 * Novi, 2 of 2) and **Sari's** (Budi and Rina, 2 of 2).
 *
 * **Derived ids, written once**: the two activations, Lukman's lead and Tari's audit row carry an `_id` from
 * `seedObjectId`, and Tari's leaving is written only while she has none, so a re-run writes nothing and a walk's
 * *Mark left* is never written over.
 */

/** The two new hires, and when. Days are counted back from the run, in the office's calendar. */
export const ACTIVATION_3M_SEED = {
  lukman: {
    email: 'lukman@kpm0417.test', fullName: 'Lukman Hakim', pronoun: 'he', agentCode: '80107',
    joinedDaysAgo: 99, saleOnDay: 96, buyer: 'Pak Hendra Kusnadi', ticked: 4,
  },
  tari: {
    email: 'tari@kpm0417.test', fullName: 'Tari Wulandari', pronoun: 'she', agentCode: '80108',
    joinedDaysAgo: 40, leftDaysAgo: 6, ticked: 3,
  },
} as const;

interface Placed { id: string; ancestorIds: string[]; depth: number }

export interface Activation3MSeedDeps {
  clock: Clock;
  kpmId: string;
  office0417: { _id: unknown; code: string; companyId: string };
  agus: Placed;
  arief: Placed;
  /** Arief's account: the actor of Tari's *Mark left*. */
  ariefUserId: string;
  user: (email: string, fullName: string, opts: { agentCode: string; pronoun: 'he' | 'she' }) => Promise<{ _id: unknown }>;
  place: (
    kpm: { _id: unknown; code: string; companyId: string }, userId: string, role: 'agent', leader: Placed,
    opts: { joinedDaysAgo: number; status?: 'removed'; removedDaysAgo?: number },
  ) => Promise<Placed>;
  recount: (kpmId: string, membershipId: string) => Promise<void>;
}

export interface Activation3MSeed {
  /** Rows this run wrote beyond the two accounts and memberships; 0 on a re-run. */
  written: number;
  members: { lukman: string; tari: string };
  guide: string;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const RECOMPILE = { overwriteModels: true } as const;

export async function seedActivation3MFixture(deps: Activation3MSeedDeps): Promise<Activation3MSeed> {
  const { clock, kpmId } = deps;
  const db = mongoose.connection.db!;
  const tz = DEFAULT_TENANT_TIMEZONE;
  const now = clock.now();
  const today = clock.localDateFor(tz, now);
  /** 10:00 office time on a day, never after the run. */
  const at = (day: LocalDate) => {
    const ten = new Date(clock.startOfLocalDay(tz, day).getTime() + 10 * 3_600_000);
    return ten < now ? ten : now;
  };
  const { lukman: L, tari: T } = ACTIVATION_3M_SEED;

  const lukmanUser = await deps.user(L.email, L.fullName, { agentCode: L.agentCode, pronoun: L.pronoun });
  const tariUser = await deps.user(T.email, T.fullName, { agentCode: T.agentCode, pronoun: T.pronoun });
  const lukman = await deps.place(deps.office0417, String(lukmanUser._id), 'agent', deps.agus, { joinedDaysAgo: L.joinedDaysAgo });
  /*
   * Tari left, and *Mark left* removes a new hire from the office (ADR-0169 §4 as amended 2026-10-27): placed removed, as
   * `RemovalService` leaves a leaver — the `joined` edge closed and a `removed` one opened, the same instant. `place()`
   * never adopts a removed row, so a re-run finds hers here first and writes no second membership.
   */
  const tariLeft = await db.collection('memberships').findOne({ kpmId, userId: String(tariUser._id), status: 'removed' });
  const tari: Placed = tariLeft
    ? { id: String(tariLeft._id), ancestorIds: tariLeft.ancestorIds as string[], depth: tariLeft.depth as number }
    : await deps.place(deps.office0417, String(tariUser._id), 'agent', deps.arief, {
      joinedDaysAgo: T.joinedDaysAgo, status: 'removed', removedDaysAgo: T.leftDaysAgo,
    });
  await deps.recount(kpmId, deps.agus.id);
  await deps.recount(kpmId, deps.arief.id);

  const checklist = await db.collection('activationTemplates')
    .find({ kpmId, status: 'published', deletedAt: null }).sort({ version: -1 }).limit(1).next();
  if (!checklist) throw new Error(`KPM ${kpmId} has no published activation checklist for the 3M fixture`);
  const items = (checklist.aspects as { items: { code: string; autoLink?: string | null }[] }[]).flatMap((a) => a.items);
  const Rows = mongoose.model(ActivationProgress.name, ActivationProgressSchema, undefined, RECOMPILE);

  let written = 0;
  const startOf = async (membershipId: string): Promise<LocalDate> => {
    const member = await db.collection('memberships').findOne({ _id: oid(membershipId) });
    return clock.localDateFor(tz, member!.joinedAt as Date);
  };

  // Each one's checklist, as a placement starts it (ADR-0103): pinned to 0417's published version, a few of their own
  // manual items ticked by themselves; the linked ones complete from their data on the first read.
  for (const [placed, ticked] of [[lukman, L.ticked], [tari, T.ticked]] as const) {
    const _id = oid(seedObjectId('activation-3m-fixture', 'activation', kpmId, placed.id));
    if (await db.collection('activationProgress').findOne({ kpmId, membershipId: placed.id, deletedAt: null })) continue;
    const startDate = await startOf(placed.id);
    const manual = items.filter((item) => mayTickByHand(item.autoLink ?? null)).slice(0, ticked).map((item) => item.code);
    const rows = items.map((item, i): ActivationItemState => {
      const done = manual.includes(item.code);
      return {
        code: item.code, done, doneAt: done ? at(addDays(startDate, 2 + i * 3)) : null, source: done ? 'hire' : null,
        doneByMembershipId: done ? placed.id : null, recordCollection: null, recordId: null, note: null, date: null,
      };
    });
    const doc = new Rows({
      _id, kpmId, membershipId: placed.id, templateId: String(checklist._id), templateVersion: checklist.version as number,
      startDate, startCorrectedAt: null, startCorrectedByMembershipId: null, origin: 'joined', items: rows, note: null,
      graduatedAt: null, graduatedByMembershipId: null, version: 1 + manual.length, deletedAt: null, createdBy: null,
      updatedBy: placed.id,
    }, null, { strict: 'throw' });
    await doc.validate();
    await Rows.collection.insertOne({ ...doc.toObject(), _id, createdAt: at(startDate), updatedAt: at(startDate) });
    written += 1;
  }
  // ADR-0169: both are new hires, joined on their activation's start.
  await markNewHires([lukman.id, tari.id]);

  // Lukman's only sale, on day 96: a sales lead walked to *Paid and issued* and won, as the leads flow takes one.
  const lukmanJoined = await startOf(lukman.id);
  const closed = addDays(lukmanJoined, L.saleOnDay - 1);
  const leadId = oid(seedObjectId('activation-3m-fixture', 'lead', kpmId, lukman.id, L.buyer));
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  if (!(await Leads.exists({ _id: leadId })) && at(closed) <= now) {
    const paidAndIssued = await db.collection('leadStatuses').findOne({ kpmId, code: FIRST_SALE_STAGE_CODE, deletedAt: null });
    const walk = ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', FIRST_SALE_STAGE_CODE] as const;
    const steps = [addDays(closed, -12), addDays(closed, -5), closed];
    const doc = new Leads({
      _id: leadId, kpmId, ownerMembershipId: lukman.id, type: 'sales', name: L.buyer,
      contact: { phone: null, email: null }, statusCode: FIRST_SALE_STAGE_CODE,
      statusId: paidAndIssued ? String(paidAndIssued._id) : null, commitments: [],
      remarks: 'Rider kesehatan untuk keluarga. Case pertamanya, setelah 90 harinya lewat.', nextActionDate: null, nextActionNote: null,
      outcome: 'won', outcomeAt: at(closed), dateRegistered: at(steps[0]), source: 'Datang langsung — BSD', loggedFrom: null,
      version: 1 + walk.length + 1,
      transitions: walk.map((code, i) => ({
        fromStatusCode: i === 0 ? null : walk[i - 1], toStatusCode: code, at: at(steps[i]), byMembershipId: lukman.id,
      })),
      deletedAt: null, createdBy: lukman.id, updatedBy: lukman.id,
    }, null, { strict: 'throw' });
    await doc.validate();
    await Leads.collection.insertOne({ ...doc.toObject(), createdAt: at(steps[0]), updatedAt: at(closed) });
    await leadPosition(db);
    written += 1;
  }

  // Tari, marked left by Arief six days ago, before any sale: `leftAt` at the instant she was removed, and its audit
  // row — what *Mark left* wrote before UI-025 retired it. It keeps no 3M result: a leaving decides nothing
  // since UI V1 (D-24), and inside her 90 days there is nothing to keep.
  const leftAt = ((await db.collection('memberships').findOne({ _id: oid(tari.id) }))!.removedAt as Date | null) ?? at(addDays(today, -T.leftDaysAgo));
  const left = await db.collection('memberships').updateOne(
    { _id: oid(tari.id), kpmId, leftAt: null },
    { $set: { leftAt, updatedBy: deps.arief.id } },
  );
  if (left.modifiedCount > 0) {
    const auditId = oid(seedObjectId('activation-3m-fixture', 'audit', kpmId, tari.id));
    if (!(await db.collection('auditLog').findOne({ _id: auditId }))) {
      await db.collection('auditLog').insertOne({
        _id: auditId, kpmId, actorUserId: deps.ariefUserId, effectiveUserId: null, actorMembershipId: deps.arief.id,
        onBehalfOf: false, action: 'new_hire.marked_left', targetCollection: 'memberships', targetId: tari.id,
        targetMembershipId: tari.id, before: { leftAt: null, activation3M: null },
        after: { leftAt: leftAt.toISOString(), activation3M: 'in_progress' }, createdAt: leftAt, updatedAt: leftAt,
      });
      written += 1;
    }
  }

  const guide = [
    '3M ACTIVATION on /new-hires (P18.8-T6; ADR-0171 §2, ADR-0173; UI V1, UI-023)  (from src/seed/activation-3m-fixture.ts)',
    `  agus@kpm0417.test    Teraktivasi: Wahyu, Novi, Budi, Rina, Indah, Dimas, Siti · amber: Lukman (day 96: ${closed})`,
    '                       Belum: Yanti, and Tari (marked left on day 35, which decides nothing)',
    '                       Aktivasi 3M 100% (7 of 7 decided; Lukman late and Tari, Yanti in their 90 days in neither part);',
    '                       Direct Unit 100%, Arief 100% (2 of 2, not 2 of 3), Sari 100%',
    '  lukman@kpm0417.test  Agus\'s agent: Pecah telor di hari ke-96, amber, outside the 3M rate (checklist overdue)',
    '  tari@kpm0417.test    Arief\'s agent, marked left by Arief before any sale: Belum, Hari ke-41 (no Keluar)',
  ].join('\n');
  return { written, members: { lukman: lukman.id, tari: tari.id }, guide };
}
