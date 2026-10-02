/**
 * **The fixture's finalized sessions get the snapshot finalize would have taken** (P11-T5, P11-T8;
 * `coaching-fixture.ts`, *How the inserting task uses it*).
 *
 * The fixture inserts its sessions with `snapshot: null`, because a snapshot is finalize's to take, with
 * finalize's own builder — so a seeded snapshot and a real one are one computation, and its activity
 * targets use the product's constants rather than a copy of them here (invariant §7). This runs that
 * builder, `CoachingSnapshotBuilder`, **as of each session's own first finalize**: the clock is set to
 * the session's `frozenAt`, so its *today* is the session's `date` in the office's zone, and the 30-day
 * ratios and the 7-day activity end there.
 *
 * - **Idempotent.** Only a session finalized at least once and still without a snapshot is filled, and
 *   the write is conditional on `snapshot: null`: a second run writes nothing, and a snapshot somebody's
 *   real finalize took in a walk is never written over.
 * - **The figures are what the office holds now**, read as of that day: activity and ratios by their
 *   windows, the goal and the production by the rows the seed wrote. A seed has no older history to read.
 * - **Wired by hand**, as the seed is a script and not the application: the same services over the same
 *   collections, with nothing that sends anything — the goal service's notifier is inert, and the builder
 *   writes no audit entry.
 */
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { ActivityLog, ActivityLogSchema } from '@/modules/activity/activity-log.schema';
import { ActivityLogRepository } from '@/modules/activity/activity-log.repository';
import { ActivityReadings } from '@/modules/activity/activity-readings';
import { ActivityService } from '@/modules/activity/activity.service';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachingSession, CoachingSessionSchema } from '@/modules/coaching/coaching-session.schema';
import { CoachingSessionRepository } from '@/modules/coaching/coaching-session.repository';
import { CoachingSessionGate } from '@/modules/coaching/coaching-session.gate';
import { CoachingSnapshotBuilder } from '@/modules/coaching/coaching-snapshot';
import { ActivityCategory, ActivityCategorySchema } from '@/modules/config/activity-category.schema';
import { ActivityType, ActivityTypeSchema } from '@/modules/config/activity-type.schema';
import { LeadStatus, LeadStatusSchema } from '@/modules/config/lead-status.schema';
import { RatioDefinition, RatioDefinitionSchema } from '@/modules/config/ratio-definition.schema';
import {
  ActivityCategoryRepository, ActivityTypeRepository, LeadStatusRepository, RatioDefinitionRepository,
} from '@/modules/config/activity.repository';
import { Goal, GoalSchema } from '@/modules/goals/goal.schema';
import { GoalRepository } from '@/modules/goals/goal.repository';
import { GoalService } from '@/modules/goals/goal.service';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { LeadReadings } from '@/modules/leads/lead-readings';
import type { NotificationService } from '@/modules/notifications/notification.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { ProductionReadings } from '@/modules/production/production-readings';
import { SummaryService } from '@/modules/summary/summary.service';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { User, UserSchema } from '@/modules/users/user.schema';

const RECOMPILE = { overwriteModels: true } as const;

/** Fill the missing snapshots of an office's finalized sessions. Answers how many it wrote. */
export async function backfillCoachingSnapshots(kpmId: string): Promise<number> {
  // Each service takes its own model's type; the seed hands it the collection's compiled model.
  const model = (name: string, schema: mongoose.Schema): never =>
    mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const clock = new FixedClock(new Date(0));

  const audit = new AuditService(model(AuditLog.name, AuditLogSchema));
  const subjectReads = new SubjectReadAudit(audit);
  const kpms = model(Kpm.name, KpmSchema);
  const memberships = new MembershipRepository(model(Membership.name, MembershipSchema));
  const coach = new CoachResolver(memberships);
  const days = new TenantDay(kpms, clock);
  const types = new ActivityTypeRepository(model(ActivityType.name, ActivityTypeSchema));
  const categories = new ActivityCategoryRepository(model(ActivityCategory.name, ActivityCategorySchema));
  const logs = new ActivityLogRepository(model(ActivityLog.name, ActivityLogSchema));
  const readings = new ActivityReadings(logs, categories, types);
  const production = new ProductionReadings(new MonthlyAgentDataRepository(model(MonthlyAgentData.name, MonthlyAgentDataSchema)));
  const goalRows = new GoalRepository(model(Goal.name, GoalSchema));
  const sessions = new CoachingSessionRepository(model(CoachingSession.name, CoachingSessionSchema));
  // Nothing here saves a goal, so nothing would announce one; inert all the same.
  const inert = { send: async () => undefined, sendCoalesced: async () => undefined } as unknown as NotificationService;
  const goals = new GoalService(
    goalRows, audit, clock, days, memberships, new MemberNames(memberships, model(User.name, UserSchema)), inert,
    production, readings, coach, new CoachingSessionGate(sessions, coach),
  );
  const activity = new ActivityService(
    logs, types, categories, coach, kpms, clock, audit, new RatioDefinitionRepository(model(RatioDefinition.name, RatioDefinitionSchema)),
    subjectReads, goals, production, readings,
  );
  const summary = new SummaryService(
    goals, production, readings, days,
    new LeadReadings(new LeadRepository(model(Lead.name, LeadSchema)), new LeadStatusRepository(model(LeadStatus.name, LeadStatusSchema)), clock),
    activity, coach, subjectReads,
  );
  const builder = new CoachingSnapshotBuilder(summary, activity, goalRows, clock);

  const Sessions = mongoose.model(CoachingSession.name);
  const pending = await Sessions.find({
    kpmId, status: { $in: ['finalized', 'reopened'] }, frozenAt: { $ne: null }, snapshot: null, deletedAt: null,
  }).sort({ frozenAt: 1 }).lean().exec() as unknown as {
    _id: mongoose.Types.ObjectId; coacheeMembershipId: string; frozenAt: Date;
  }[];

  const ctx = RequestContext.forJob(kpmId, 'seed-coaching-snapshots');
  let written = 0;
  for (const session of pending) {
    const coachee = await mongoose.model(Membership.name).findOne({ _id: session.coacheeMembershipId, kpmId }).lean().exec() as
      { orgLevelCode: string } | null;
    if (!coachee) continue;
    clock.set(session.frozenAt);
    const snapshot = await builder.build(ctx, {
      membershipId: session.coacheeMembershipId, orgLevelCode: coachee.orgLevelCode, self: false,
    });
    // Not an edit of the session: its `updatedAt` stays the fixture's, as finalize left it.
    const result = await Sessions.updateOne(
      { _id: session._id, kpmId, snapshot: null }, { $set: { snapshot } }, { timestamps: false },
    ).exec();
    written += result.modifiedCount;
  }
  return written;
}
