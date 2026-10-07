import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type MembershipDocument = HydratedDocument<Membership>;

export type HierarchyRole = 'ab' | 'aab' | 'agent';

/**
 * Direct reports per ladder rung, plus the total.
 *
 * Keyed by rung **code**, so a company that publishes a fourth rung is counted rather
 * than silently dropped.
 */
export interface DirectCounts {
  total: number;
  [orgLevelCode: string]: number;
}
export type MembershipStatus = 'active' | 'pending' | 'removed';

/** Delegated tenant-admin rights. Orthogonal to hierarchy role — an AB may hold them. */
export class AdminAccess {
  isKpmAdmin!: boolean;
  grantedByUserId!: string | null;
  grantedAt!: Date | null;
  revokedAt!: Date | null;
}

/**
 * Participation in one office.
 *
 * Identity is global and participation is tenant-scoped, so this — not `users` — is what
 * every per-user document points at. `membershipId` is the foreign key; `userId` is not,
 * and neither is a name (`domain-invariants.md` §2). A person who leaves and rejoins
 * gets a new membership, and their history stays with the tenant that owns it.
 */
@Schema({ ...baseSchemaOptions, collection: 'memberships' })
export class Membership {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  /**
   * `KPM0417-001`. Server-issued from the tenant counter and immutable: the monthly
   * production import joins on it, so changing one silently breaks the attribution of
   * every row already imported under the old value.
   *
   * Unique within the office, not globally — two offices may both have a `-001`.
   */
  @Prop({ type: String, required: true })
  agentCode!: string;

  /**
   * The sequence inside the code, kept as a number because the roster orders by it.
   *
   * Ordering on the string breaks at four digits: `KPM0417-1000` sorts before
   * `KPM0417-999`, which would silently reorder the directory and — worse — make the
   * cursor skip rows, since the cursor is a `$gt` on the sort key. Padding wide enough
   * to hide it would change a format the prototype already shows to users.
   */
  @Prop({ type: Number, required: true })
  agentSeq!: number;

  /**
   * The code this person shares to bring somebody into their unit.
   *
   * **One per membership, generated with it, never reissued and never withdrawn**
   * (P3.6-T1). The prototype shows exactly this — a link, a code and a QR, all three
   * *copyable*, over a value that already exists (`Overall.html:3578-3596`,
   * `User_Management_Section.html:446-454`). It has no create button and no revoke, and
   * neither do we any more: a code that cannot be reissued must not be revocable, or
   * withdrawing it leaves that leader permanently unable to invite anybody.
   *
   * **Unique across every office**, not within one. A joiner presents it before they
   * belong anywhere, so there is no office to scope the lookup to — it is the code that
   * names the office, not the reverse. Scoped to live rows, so a soft-deleted membership
   * releases its code.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  leaderCode!: string;

  /**
   * → `companyOrgLevels._id`. **The stored truth about where somebody stands** (ADR-0012).
   *
   * Required, and resolved from the office's company on every write. A membership with no
   * level is the defect the reference exists to prevent, and it would be invisible until
   * a screen tried to read it — so the resolution throws rather than writing null.
   */
  @Prop({ type: String, required: true, index: true })
  orgLevelId!: string;

  /**
   * The rung's **code**, denormalised (P4-T9).
   *
   * `AGENT`, `AAB`, `AB` in v1's seeded ladder. Safe to copy because a published code
   * never changes (ADR-0006) — the same argument `agentCode` already rests on — and it
   * has to be here rather than joined because `ContextResolver` reads it on **every
   * request**, and a third lookup on that path is not free.
   *
   * This is what a hierarchy permission grant is compared against since `P4-T9`. `role`
   * below is the enum it used to be compared against, and an enum of three fixed names
   * cannot describe a ladder a second insurer has not published yet.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  orgLevelCode!: string;

  /**
   * **Derived from `orgLevelId`, never written on its own.**
   *
   * **No longer an authorisation input** (P4-T9). Permission grants compare against
   * `orgLevelCode`; this is read by the services that sort, group and label — the org
   * tree, the directory, the unit dashboard — where a stable three-value enum is a
   * convenience rather than a constraint.
   *
   * It stays because removing the *field* is a data migration across seven services, and
   * because v1 seeds exactly one ladder so the two are one-to-one. What P4-T9 removed is
   * the part that mattered: an enum of three fixed names deciding who may do what, in a
   * product whose ladder is company configuration (ADR-0012).
   *
   * Every write goes through `HierarchyService`, which sets it from the resolved level's
   * `code`. Setting it directly is how the two come to disagree.
   */
  @Prop({ type: String, enum: ['ab', 'aab', 'agent'], required: true })
  role!: HierarchyRole;

  /** → `memberships._id`. Null for a top-level AB. */
  @Prop({ type: String, default: null, index: true })
  leaderId!: string | null;

  /** Materialised, root-first, excluding self. Multikey-indexed — the descendant query. */
  @Prop({ type: [String], default: [] })
  ancestorIds!: string[];

  @Prop({ type: Number, default: 0 })
  depth!: number;

  /**
   * Caches, rebuilt on re-parenting. `total` is what makes someone a leader (OD-23) —
   * the role does not.
   */
  /**
   * Direct reports, counted **by ladder code** (P4-T9).
   *
   * `{ AGENT: 3, AAB: 1, total: 4 }`. It was `{ ab, aab, agent, total }` — three fixed
   * keys, which silently counts nothing for a rung a second insurer publishes, and a
   * screen reading it would show a leader with reports as leading nobody.
   *
   * `total` is what makes somebody a leader (OD-23); the rung does not.
   */
  @Prop({ type: Object, default: () => ({ total: 0 }) })
  directCounts!: DirectCounts;

  @Prop({ type: Number, default: 0 })
  subtreeCount!: number;

  @Prop({ type: String, enum: ['active', 'pending', 'removed'], default: 'pending', index: true })
  status!: MembershipStatus;

  @Prop({ type: Date, default: null })
  joinedAt!: Date | null;

  @Prop({ type: Date, default: null })
  removedAt!: Date | null;

  @Prop({ type: Boolean, default: false })
  isCoreLeader!: boolean;

  @Prop({ type: [String], default: [] })
  groupIds!: string[];

  @Prop({
    type: Object,
    default: () => ({ isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null }),
  })
  adminAccess!: AdminAccess;

  /** Who brought them in, and from which recruitment lead. Attribution, set at join. */
  @Prop({ type: String, default: null })
  recruitedByMembershipId!: string | null;

  @Prop({ type: String, default: null })
  sourceLeadId!: string | null;

  /**
   * ***Hide my personal activities*** (ADR-0110, amending ADR-0093; `functional/calendar.md`, *Who reads
   * what*): when `true`, a leader who compares this member's week is answered every entry the member
   * organised as a busy block — its time and nothing else — unless that leader is on it. **Off by
   * default**, and the member's own to switch, from `/calendar` (`PUT /calendar/settings`).
   *
   * On the membership because it is how this person takes part in this office's calendar, as the rest of
   * this record is (invariant §2): it is scoped and indexed as the membership already is, and somebody who
   * leaves and rejoins starts with it off. A row written before it existed has no value, which reads as off.
   */
  @Prop({ type: Boolean, default: false })
  calendarHideDetails!: boolean;

  /*
   * No `activationGraduatedAt`. It sat here unwritten from Phase 3, waiting for Phase 13 — which records
   * graduation on the hire's `activationProgress` (`graduatedAt`, `graduatedByMembershipId`), with the rest
   * of the activation, so the fact lives in one place rather than two that could disagree (P13-T0 AC-4).
   */

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const MembershipSchema = SchemaFactory.createForClass(Membership);

/**
 * `kpmId` leads every index, so no query plan can wander across tenants.
 *
 * **This was `unique` until 2026-09-08, and could not stay.** The code belongs to the
 * person now (ADR-0017), so somebody who leaves and rejoins the same office brings the
 * same one back — and their removed row is still there, because nothing is deleted. A
 * unique index over both rows refused the return. Making it partial is not available
 * either: Mongo's `partialFilterExpression` has no `$ne`, and "every row that is not
 * removed" is exactly that shape.
 *
 * Nothing is lost. Uniqueness is enforced where the code is **owned** — `(companyId,
 * agentCode)` on `users` — and a person may hold only one live membership per office, so
 * two live rows in one office cannot carry one code. This index now exists to serve the
 * roster's code search, which is what it was really doing all along.
 */
MembershipSchema.index({ kpmId: 1, agentCode: 1 });

/**
 * The leader code is looked up by code alone, so it is unique globally and indexed that
 * way — the one index on this collection that deliberately does not lead with `kpmId`.
 *
 * That is not a hole in invariant §1. The rule guards against a query plan wandering
 * across tenants while *serving one tenant's request*; this lookup has no tenant yet,
 * because the person doing it has no office. `inviteCodes` carried the same index for the
 * same reason before it retired.
 */
MembershipSchema.index(
  { leaderCode: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/**
 * At most one live membership per person per office, enforced by the database rather
 * than a read-then-write two concurrent joins would race past. `removed` rows are
 * exempt: re-joining creates a new membership and the old one stays (P3-T7).
 */
MembershipSchema.index(
  { kpmId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['active', 'pending'] } } },
);

MembershipSchema.index({ kpmId: 1, leaderId: 1, status: 1 });
/** The descendant query — the most common in the product, behind every rollup. */
MembershipSchema.index({ kpmId: 1, ancestorIds: 1, status: 1 });
MembershipSchema.index({ kpmId: 1, status: 1, agentSeq: 1 });
