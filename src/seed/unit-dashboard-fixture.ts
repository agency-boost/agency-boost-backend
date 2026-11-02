import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, UNIT_DASHBOARD_CORRECTION_REASON } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { MemberNames } from '@/modules/org/member-names.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { ProductionCorrections } from '@/modules/production/production-correction.service';
import { ProductionMonth, ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { ProductionMonthRepository } from '@/modules/production/production-month.repository';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { MINOR_UNITS_PER_RP_MILLION } from '@/modules/production/production-units';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **The Unit Dashboard, seeded** (Phase 15, *Seed*; P15-T1 AC-12, P15-T3 AC-5; `functional/unit-dashboard.md`,
 * *Seed*).
 *
 * Almost everything the dashboard reads is seeded already: the coaching cast's weeks of activity, leads with
 * commitments, goals, the two months' files with the Admin's correction over this month's, and the finalized
 * sessions (`coaching-fixture.ts`). This adds only what the dashboard is the first to show. Which account
 * shows what:
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `agus@kpm0417.test` (AB) | The whole roster: *Your Unit* — Agus (*You*), Dimas, Indah, Siti; units — Arief (Novi, Wahyu), Dewi alone, Sari (Budi, Rina, Yanti). Every status, every *Last 1:1* (`coaching-fixture.ts`'s table) |
 * | | **Production.** Budi and Yanti are left out of this month's file (`demo.ts`), so their month reads *Not uploaded yet* and their unit's month total names two missing. **New:** Sari's correction of **Budi's year to date** through *Update production* — under *This year* Budi's goal cell carries the correction's mark with Sari's name, and the production cell's year shows it; his month stays *Not uploaded yet*, as his Summary has always read |
 * | | **Leads.** Budi's recruitment lead promised this month (*Pak Andi Kurniawan*), so *Your AABs* reads *1 candidate*. **New:** a recruitment lead of Indah's promised this month (*Sdri. Laras Wulandari*), so *Your unit* reads *1 candidate* |
 * | | **Follow-up** (OD-140, typed or from a lead — nothing new is seeded for it): **Sari** *Overdue 9d*, a typed item of her last 1:1 with Agus twelve days ago (*Go through Budi's lapsed prospects with him*); **Indah** *Overdue 2d*, a lead action her 1:1 four days ago froze (*Collect the signed SPAJ.*); **Rina** *Overdue 6d*, a lead action today's 1:1 froze as Pak Hendro's lead stood (*Chase the illustration.*) |
 * | `admin@kpm0417.test` opening Agus's unit (`/unit/dashboard/{agus}`) | The same rows, **without a lead's text** (roles §3.7): the Admin coaches none of them, so no lead action is a follow-up — Sari's typed item stands (*Overdue 9d*), Indah's falls back to a typed item (*Overdue 1d*), Rina's to one dated two days ahead. No row opens coaching (`coached: false`). The Owner, the root AB above them all, reads what Agus reads |
 * | `sari@kpm0417.test` (AAB) | Her unit: Sari, Budi, Rina, Yanti; Budi's year carries her own correction's mark. *Update production* for the four |
 * | `arief@kpm0417.test` (AAB) | Arief, Novi, Wahyu |
 * | `dewi@kpm0417.test`, `rina@kpm0417.test` | Lead nobody: the empty state on a typed address |
 * | `owner@kpm0417.test` through *Open agent view* | The root AB: the whole office |
 *
 * **The correction goes through the new path** — `ProductionCorrections.correctApe`, the function *Update
 * production* writes through — as Sari, with `UNIT_DASHBOARD_CORRECTION_REASON`, so the cell, the month's
 * revision and the `upload.cell_corrected` audit row (`after.surface: 'unit_dashboard'`) are what the product
 * writes, not a copy of them.
 *
 * **Written once, until `--reset`.** The lead's `_id` is derived (`seedObjectId`), and the correction's marker
 * is its audit row for the month: a re-run writes nothing, a run in a new month corrects that month's, and a
 * year to date somebody already corrected by hand this month — in a walk — is left as they left it. A month
 * locked by hand is left alone too.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** The new recruitment lead of Indah's, promised this month. */
export const UNIT_DASHBOARD_INDAH_LEAD = {
  name: 'Sdri. Laras Wulandari',
  path: ['NOT_APPROACHED', 'MEETING_SCHEDULED'],
  nextActionInDays: 5,
  nextActionNote: 'Undang ke BOP hari Kamis.',
} as const;

/** Sari's correction of Budi's year to date: the company report's figure, Rp 14 M above last month's. */
export const UNIT_DASHBOARD_BUDI_YTD_ABOVE_LAST_MONTH = 14 * MINOR_UNITS_PER_RP_MILLION;

/** The derived id of the lead this fixture writes. */
export const unitDashboardLeadId = (kpmId: string) => seedObjectId('unit-dashboard-fixture', 'lead', kpmId, 'indah-recruitment');

export interface UnitDashboardFixtureDeps {
  clock: Clock;
  kpm0417: string;
  indah: string;
  budi: string;
  sari: { membershipId: string; userId: string };
}

export interface UnitDashboardFixture {
  /** Rows this run wrote: the lead and the correction, or nothing on a re-run. */
  written: number;
  guide: string;
}

export async function seedUnitDashboardFixture(deps: UnitDashboardFixtureDeps): Promise<UnitDashboardFixture> {
  const { clock, kpm0417: kpmId } = deps;
  const Leads = mongoose.model(Lead.name, LeadSchema, undefined, RECOMPILE);
  const LeadStatuses = mongoose.model(LeadStatus.name, LeadStatusSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  const MonthRows = mongoose.model(MonthlyAgentData.name, MonthlyAgentDataSchema, undefined, RECOMPILE);
  const now = clock.now();
  const today = clock.localDateFor(DEFAULT_TENANT_TIMEZONE, now);
  const month = today.slice(0, 7);
  let written = 0;

  // ---- Indah's recruitment lead, promised this month.
  const leadId = unitDashboardLeadId(kpmId);
  if (!(await Leads.exists({ _id: new mongoose.Types.ObjectId(leadId) }).exec())) {
    const { name, path, nextActionInDays, nextActionNote } = UNIT_DASHBOARD_INDAH_LEAD;
    const status = await LeadStatuses.findOne({ kpmId, code: path.at(-1) }).lean().exec();
    const transitions = path.map((code, i) => ({
      fromStatusCode: i === 0 ? null : path[i - 1], toStatusCode: code,
      at: new Date(now.getTime() - (10 - i * 4) * DAY_MS), byMembershipId: deps.indah,
    }));
    await Leads.create({
      _id: new mongoose.Types.ObjectId(leadId),
      kpmId, ownerMembershipId: deps.indah, name, type: 'recruitment',
      contact: { phone: null, email: null },
      statusCode: path.at(-1), statusId: status ? String((status as { _id: unknown })._id) : null,
      commitments: [{ month, at: new Date(now.getTime() - 2 * DAY_MS), byMembershipId: deps.indah }],
      remarks: 'Ketemu di acara keluarga; penasaran soal penghasilan tambahan.',
      // Dated, so a session with Indah never refuses to finalize over it (`LEAD_THIS_MONTH_UNDATED`).
      nextActionDate: addDays(today, nextActionInDays), nextActionNote,
      outcome: null, outcomeAt: null, dateRegistered: new Date(now.getTime() - 10 * DAY_MS), source: 'Jaringan pribadi',
      version: 1 + transitions.length, transitions, deletedAt: null, createdBy: deps.indah, updatedBy: deps.indah,
    });
    written += 1;
  }

  // ---- Sari's correction of Budi's year to date, through *Update production*'s own function.
  const marked = await Audit.exists({
    kpmId, action: 'upload.cell_corrected', targetMembershipId: deps.budi, 'after.surface': 'unit_dashboard', 'after.month': month,
  }).exec();
  const budiThisMonth = await MonthRows.findOne({ kpmId, membershipId: deps.budi, month, deletedAt: null }).lean().exec();
  const alreadyCorrected = (budiThisMonth as { apeYtd?: { provenance?: string } } | null)?.apeYtd?.provenance === 'corrected';
  if (!marked && !alreadyCorrected) {
    const [lastHeld] = await MonthRows.find({
      kpmId, membershipId: deps.budi, deletedAt: null, month: { $gte: `${month.slice(0, 4)}-01`, $lt: month }, 'apeYtd.value': { $ne: null },
    }).sort({ month: -1 }).limit(1).lean().exec();
    const ytd = ((lastHeld as { apeYtd?: { value?: number } } | undefined)?.apeYtd?.value ?? 0)
      + UNIT_DASHBOARD_BUDI_YTD_ABOVE_LAST_MONTH;

    const memberships = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE) as never);
    const audit = new AuditService(Audit as never);
    const months = new ProductionMonths(
      new ProductionMonthRepository(mongoose.model(ProductionMonth.name, ProductionMonthSchema, undefined, RECOMPILE) as never),
      mongoose.model(Kpm.name, KpmSchema, undefined, RECOMPILE) as never,
      clock,
      new MemberNames(memberships, mongoose.model(User.name, UserSchema, undefined, RECOMPILE) as never),
      audit,
    );
    const corrections = new ProductionCorrections(
      months, new MonthlyAgentDataRepository(MonthRows as never), memberships, audit, clock,
    );
    const asSari = new RequestContext(deps.sari.userId, 'none', {
      membershipId: deps.sari.membershipId, kpmId, orgLevelCode: 'AAB', hierarchyRole: 'aab',
      status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 3,
    });
    try {
      const { revision } = await months.state(asSari, month);
      const result = await corrections.correctApe(asSari, {
        month, revision, rows: [{ membershipId: deps.budi, apeYtdMinor: ytd }],
        reason: UNIT_DASHBOARD_CORRECTION_REASON, surface: 'unit_dashboard',
      });
      written += result.updated;
    } catch (err) {
      // A month somebody locked, or wrote to in the same instant, is theirs: the seed does not force it.
      if (!(err instanceof DomainException)) throw err;
    }
  }

  const guide = `
  UNIT DASHBOARD at /unit/dashboard  (from src/seed/unit-dashboard-fixture.ts)
    agus@kpm0417.test            the whole roster: Your Unit (Agus, Dimas, Indah, Siti), then Arief's,
                                 Dewi's and Sari's units. Every status and every Last 1:1. This month,
                                 Budi and Yanti read "Not uploaded yet"; This year, Budi's goal carries
                                 Sari's correction from Update production, with her name. Potential
                                 Recruits: Indah's Sdri. Laras Wulandari (your unit), Budi's Pak Andi
                                 Kurniawan (your AABs). Follow-up, typed or from a lead: Sari Overdue 9d
                                 (a typed item), Indah Overdue 2d and Rina Overdue 6d (lead actions their
                                 1:1s froze). An Admin opening the unit reads no lead's text: Sari's stands,
                                 Indah's and Rina's fall back to a typed item (Overdue 1d; in two days)
    sari@kpm0417.test            her unit only, and Update production for the four
    arief@kpm0417.test           his unit: Arief, Novi, Wahyu
    dewi@ · rina@kpm0417.test    lead nobody: the empty state on a typed address
    owner@kpm0417.test           Open agent view: the whole office, as its root AB
`;

  return { written, guide };
}
