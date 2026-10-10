import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { TrainingStatus } from '@/domain/constants';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { CampaignChase, CampaignChaseSchema } from '@/modules/campaigns/campaign-chase.schema';
import { CampaignChaseRepository } from '@/modules/campaigns/campaign-chase.repository';
import { CampaignEvaluation, evaluationInput } from '@/modules/campaigns/campaign-evaluation';
import { CampaignStanding, CampaignStandingSchema } from '@/modules/campaigns/campaign-standing.schema';
import { CampaignStandingRepository } from '@/modules/campaigns/campaign-standing.repository';
import { CampaignStandingOverrides } from '@/modules/campaigns/campaign-standing-overrides';
import { Campaign, CampaignSchema } from '@/modules/campaigns/campaign.schema';
import { CampaignRepository } from '@/modules/campaigns/campaign.repository';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { MemberNames } from '@/modules/org/member-names.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { ProductionMonth, ProductionMonthSchema } from '@/modules/production/production-month.schema';
import { ProductionMonthRepository } from '@/modules/production/production-month.repository';
import { ProductionMonths } from '@/modules/production/production-months.service';
import { ProductionReadings } from '@/modules/production/production-readings';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { TrainingProgress, TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { seedObjectId } from './coaching-fixture';
import type { ReportingKey } from './reporting-fixture';
import { SALES } from './training-fixture';

/**
 * **The Owner's compliance tree, seeded** (Phase 18.6, P18.6-T3 AC-1; the phase file's *Seed*). Almost everything the
 * tree reads is seeded already — `local-development.md`'s *Activation*, *Owner reporting*, *Training*, *Events* and
 * *Campaigns* — so this adds two things, and **no member, activity day, goal, production month, event, RSVP,
 * confirmation, answer or chase**:
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test` (Wilson Tanoto), `admin@kpm0417.test` (Maya Halim) at `/kpm/analytics/compliance` | **Training**, Yosef's agency: **Arini** all ten Sales modules *Completed* — the chip moves from two (Agus, Siti) to three — **Bonar** five, **Cahya** and **Damar** one *In progress*, **Elsa** none, Yosef none; **Winda's unit** (Winda, Ikhsan, Jihan, Kemal) two each; **Satria's agency** none — so every unit card holds every training state |
 * | the same, *Campaigns* → the persistency push (*Seasonal — Past*) | **Rina** *Achieved*; **Budi** *Achieved* with the override's icon — *"Overridden by Wilson Tanoto on {date}: Persistency corrected by the carrier after the month locked."* — where the campaign reads *Not met*; clear it with a reason and it reads *Not achieved* |
 * | `admin@kpm0417.test` at `/admin/audit` | `campaign_standing.finalised` for the push's window and `campaign_standing.overridden` for Budi, both by the Owner |
 * | `budi@kpm0417.test` | The push's dialog **unchanged** — its rows, no status (ADR-0147) |
 *
 * **D-seed's override** (option *a*) is written only once the push is final — its month locked, from the office's 8th
 * (ADR-0144) — **through the campaigns module's own write** (`CampaignStandingOverrides`), audited, as the Owner. Being
 * the first read after the lock, it freezes the window first, as any reader would: Rina's and Budi's standings are
 * stored then rather than on the first walk's read, with the same values. Before the 8th it is skipped and the guide
 * says so. **A standing with any override history is left as it is** — the row's `version` moves with every override
 * write, so one a walk set, changed or cleared since is never restored or audited again by a re-run without `--reset`
 * (the exit review's L1), and the guide says which. **The one visible change**
 * is the Owner's view of the push (flagged in `local-development.md`); Budi's own screens do not move.
 *
 * **No reviewed walk moves**: Phase 18's cast's training is read by no reviewed walk (their activations graduated long
 * ago, so no training link is evaluated for them). **Derived ids, written once until `--reset`**: a progress row only
 * where neither this fixture's row nor any live row for the member and module exists; a re-run writes nothing.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

type SalesCode = (typeof SALES)[number];

/** Phase 18's cast whose training this seeds, by the reporting fixture's key. Anybody unlisted has none. */
export const COMPLIANCE_TRAINING_SEED: Readonly<Partial<Record<ReportingKey, { done: readonly SalesCode[]; inProgress: readonly SalesCode[] }>>> = {
  // Yosef's agency: a mix.
  arini: { done: SALES, inProgress: [] },
  bonar: { done: SALES.slice(0, 5), inProgress: [] },
  cahya: { done: [], inProgress: SALES.slice(0, 1) },
  damar: { done: [], inProgress: SALES.slice(0, 1) },
  // Winda's unit: two each.
  winda: { done: SALES.slice(0, 2), inProgress: [] },
  ikhsan: { done: SALES.slice(0, 2), inProgress: [] },
  jihan: { done: SALES.slice(0, 2), inProgress: [] },
  kemal: { done: SALES.slice(0, 2), inProgress: [] },
};

/** D-seed (option *a*): Budi's final standing in the persistency push, set *Achieved* by the Owner. */
export const COMPLIANCE_OVERRIDE_SEED = {
  campaignCode: 'PERSISTENCY_PUSH',
  status: 'qualified',
  reason: 'Persistency corrected by the carrier after the month locked.',
} as const;

export interface ComplianceFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** Wilson Tanoto: the Owner the override is written as. */
  owner: { membershipId: string; userId: string };
  /** Budi's membership, whose standing is overridden. */
  budi: string;
  /** Phase 18's cast, membership ids by the reporting fixture's key. */
  cast: Partial<Record<ReportingKey, string>>;
}

export interface ComplianceFixture {
  /** Rows this run wrote: progress rows and the override — 0 on a re-run. */
  written: number;
  /**
   * `'set'` — Budi's standing reads the seeded override; `'history: …'` — it has an override history a walk made (set
   * or cleared since the seed), left as it is; or `'skipped: …'`, why it was not written on this run.
   */
  override: 'set' | string;
  guide: string;
}

/** A progress row's derived id: one per office, member and module. */
export const complianceProgressId = (kpmId: string, membershipId: string, moduleCode: string) =>
  seedObjectId('compliance-fixture', 'progress', kpmId, membershipId, moduleCode);

export async function seedComplianceFixture(deps: ComplianceFixtureDeps): Promise<ComplianceFixture> {
  // Each service takes its own model's type; the seed hands it the collection's compiled model.
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const Progress = mongoose.model(TrainingProgress.name, TrainingProgressSchema, undefined, RECOMPILE);
  const { clock, kpmId } = deps;
  const now = clock.now();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  let written = 0;

  // ------------------------------------------------ training for Phase 18's cast

  /** One member's row of one module, as the training fixture writes its own: only where nothing is there yet. */
  const row = async (membershipId: string, moduleCode: SalesCode, status: TrainingStatus, started: number, completed: number | null) => {
    const _id = new mongoose.Types.ObjectId(complianceProgressId(kpmId, membershipId, moduleCode));
    if (await Progress.exists({ _id })) return;
    if (await Progress.exists({ kpmId, membershipId, moduleCode, deletedAt: null })) return;
    const doc = new Progress({
      _id, kpmId, membershipId, moduleCode, status, startedAt: daysAgo(started),
      completedAt: completed === null ? null : daysAgo(completed),
      opened: [], version: status === 'done' ? 3 : 2, deletedAt: null, createdBy: membershipId, updatedBy: membershipId,
    }, null, { strict: 'throw' });
    await doc.validate();
    await Progress.collection.insertOne({ ...doc.toObject(), createdAt: daysAgo(started), updatedAt: daysAgo(completed ?? started) });
    written += 1;
  };
  for (const [key, plan] of Object.entries(COMPLIANCE_TRAINING_SEED) as [ReportingKey, { done: readonly SalesCode[]; inProgress: readonly SalesCode[] }][]) {
    const membershipId = deps.cast[key];
    if (!membershipId) continue;
    const all = [...plan.done, ...plan.inProgress];
    // Two days apart, the last finished four days ago; each started two days before it finished.
    for (const [k, code] of all.entries()) {
      const finished = 4 + (all.length - 1 - k) * 2;
      const done = k < plan.done.length;
      await row(membershipId, code, done ? 'done' : 'in_progress', finished + 2, done ? finished : null);
    }
  }

  // ------------------------------------------------ D-seed: Budi's final persistency standing, overridden by the Owner

  const audit = new AuditService(model(AuditLog.name, AuditLogSchema));
  const kpms = model(Kpm.name, KpmSchema);
  const memberships = new MembershipRepository(model(Membership.name, MembershipSchema));
  const names = new MemberNames(memberships, model(User.name, UserSchema));
  const campaigns = new CampaignRepository(model(Campaign.name, CampaignSchema));
  const standings = new CampaignStandingRepository(model(CampaignStanding.name, CampaignStandingSchema));
  const evaluation = new CampaignEvaluation(
    new ProductionReadings(new MonthlyAgentDataRepository(model(MonthlyAgentData.name, MonthlyAgentDataSchema))),
    new ProductionMonths(new ProductionMonthRepository(model(ProductionMonth.name, ProductionMonthSchema)), kpms, clock, names, audit),
    new ActivityReadings(
      new ActivityLogRepository(model(ActivityLog.name, ActivityLogSchema)),
      new ActivityCategoryRepository(model(ActivityCategory.name, ActivityCategorySchema)),
      new ActivityTypeRepository(model(ActivityType.name, ActivityTypeSchema)),
    ),
    new RatioDefinitionRepository(model(RatioDefinition.name, RatioDefinitionSchema)),
    memberships,
    new CampaignChaseRepository(model(CampaignChase.name, CampaignChaseSchema)),
    standings,
    campaigns,
    new TenantDay(kpms, clock),
    clock,
    audit,
  );
  const overrides = new CampaignStandingOverrides(campaigns, memberships, standings, evaluation, names, audit, clock);
  const ctx = new RequestContext(deps.owner.userId, 'none', {
    membershipId: deps.owner.membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });

  const { campaignCode, status, reason } = COMPLIANCE_OVERRIDE_SEED;
  const push = await campaigns.findOne(ctx, { code: campaignCode, status: 'active' });
  let override: ComplianceFixture['override'];
  let title: string = campaignCode;
  if (!push) {
    override = `skipped: ${campaignCode} is not seeded`;
  } else {
    title = push.title;
    // The first read after the lock freezes the window, as any reader's would; before the lock it writes nothing.
    const evaluated = (await evaluation.evaluate(ctx, [evaluationInput(push)], [deps.budi])).get(push.code)!;
    const stored = evaluated.final
      ? await standings.findOne(ctx, { campaignCode, windowKey: evaluated.window.key, membershipId: deps.budi })
      : null;
    if (!evaluated.final) {
      override = `skipped: ${title} is not final until its month locks, on the office's 8th — re-run the seed then`;
    } else if (!stored) {
      override = `skipped: Budi has no final standing in ${title}`;
    } else if (((stored.get('version') as number | undefined) ?? 0) > 0 || stored.override !== null) {
      // **Any override history** — the seed's own, or one a walk set or cleared since (the row's version moves with
      // every override write): a re-run without `--reset` restores nothing a walk undid, and audits nothing again.
      const o = stored.override;
      override = o !== null && o.status === status && o.reason === reason
        ? 'set'
        : `history: Budi's standing in ${title} was ${o === null ? 'overridden and then cleared' : 'overridden again'} since the seed`;
    } else if (stored.status === status) {
      override = `skipped: Budi already qualified for ${title}`;
    } else {
      await overrides.override(ctx, campaignCode, deps.budi, { status, reason });
      written += 1;
      override = 'set';
    }
  }

  const guide = `
  COMPLIANCE at /kpm/analytics/compliance  (the Owner's and the Admins'; from src/seed/compliance-fixture.ts)
    owner@ · admin@kpm0417.test  Training: Yosef's agency — Arini all ten Completed (the chip reads 3 with
                                 Agus and Siti), Bonar five, Cahya and Damar one In progress, Elsa none;
                                 Winda's unit two each; Satria's agency none
                                 Campaigns › ${title} (Seasonal — Past): Rina Achieved; ${override === 'set'
    ? `Budi Achieved
                                 with the override's icon — "Persistency corrected by the carrier after
                                 the month locked." Clear it with a reason: Not achieved`
    : override.startsWith('history: ')
      ? `Budi as the walks
                                 left him: ${override.replace(/^history: /, '')} — left as it
                                 is; pnpm seed:demo --reset for the seeded override`
      : `Budi Not achieved —
                                 no override this run (${override.replace(/^skipped: /, '')})`}
    budi@kpm0417.test            ${title}'s dialog unchanged: its rows, no status
`;
  return { written, override, guide };
}
