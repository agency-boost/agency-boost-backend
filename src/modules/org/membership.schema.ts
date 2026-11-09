import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { JOINED_AS, WORK_STATUSES, type JoinedAs, type WorkStatus } from '@/domain/constants';
import { ACTIVATION_3M_LOCKS, type Activation3MLock } from '@/domain/metrics/activation-3m';
import {
  FIRST_SALE_SOURCES, type FirstSaleRecordCollection, type FirstSaleSource,
} from '@/domain/metrics/first-sale';

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
   * **A copy of `users.agentCode`**, the producer id the person's insurer issued them (ADR-0017),
   * written once when the membership is made and never minted here. It was `KPM0417-001`, issued
   * from the tenant counter, until 2026-09-08; that format is gone. Digits only on every new code
   * since ADR-0158 §4 — a code already held keeps its letters.
   *
   * Immutable: the monthly production import joins on it, so changing one silently breaks the
   * attribution of every row already imported under the old value. Unique where it is owned,
   * `(companyId, agentCode)` on `users`; the index below serves the roster's search.
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
   * (P3.2-T1). The prototype shows exactly this — a link, a code and a QR, all three
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
   * A hierarchy permission grant was compared against this from `P4-T9` until ADR-0156,
   * and a rung a company named itself therefore held nobody's rights. Grants read the
   * class below now; this is what the badge and the config bound to rungs read.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  orgLevelCode!: string;

  /**
   * **The class, derived from the rung's leader tier, never written on its own** (ADR-0156).
   *
   * *Senior Leader* → `ab`, *Associate Leader* → `aab`, none → `agent`, whatever the rung's
   * code. **The authorisation input again since ADR-0156**: a hierarchy grant matches the
   * class, so a custom rung holds its tier's rights; *Leaders used* counts `ab` and `aab`;
   * the Owner's agency and unit partitions read it; and the services that sort, group and
   * label — the org tree, the directory, the unit dashboard — read it as they always did.
   *
   * It was derived from the rung's code lower-cased from P3.1-T8 until P18.5-T1, which made
   * it one-to-one with v1's one ladder and meaningless for any other (OD-50, narrowed).
   *
   * Every write goes through `HierarchyService`, which sets it from the resolved level's
   * tier. Setting it directly is how the two come to disagree.
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

  /**
   * **The system's stamp**: the instant the membership was made active (ADR-0169 §5). Not the person's join date,
   * which is `joinDate` — the two can differ, and every business rule reads `joinDate`.
   */
  @Prop({ type: Date, default: null })
  joinedAt!: Date | null;

  /**
   * ***Join date*: the day this person joined the office, as their leader gives it** (ADR-0169 §1, P18.8-T2). An
   * **office date** `YYYY-MM-DD` in `kpms.timezone`, never an instant (invariant §9), set when the membership is
   * made active — an approval, a tag, a leader's code, a roster import, an Owner assigned — and the office's today
   * unless a leader named another. A new hire's activation starts on it, and a leader's correction moves both
   * (ADR-0102 as noted). `null` while the membership is pending: nobody has let them in yet.
   */
  @Prop({ type: String, default: null })
  joinDate!: string | null;

  /**
   * ***New hire* or *existing agent*, decided once** (ADR-0169 §3): `new_hire` when `joinDate` was no more than
   * `JOINING.NEW_HIRE_MAX_DAYS_BACK` days before the office's today when it was first set, else `existing_agent`.
   * **Nothing recomputes it**: a later correction of the date does not reclassify. Only a new hire is given an
   * activation. A roster import and an office's Owner are existing agents. `null` while pending.
   */
  @Prop({ type: String, enum: [...JOINED_AS, null], default: null })
  joinedAs!: JoinedAs | null;

  /**
   * **The instant a leader marked this new hire as having left** (ADR-0169 §4 as amended 2026-10-27, ADR-0173): written
   * by *Mark left* (P18.8-T6), which then removes the membership through the removal's own path — `status: removed`,
   * `removedAt` the same instant — so a leaver leaves every count of people. The record and its history stay, and a
   * removed membership with `leftAt` is a new hire who left, which `/new-hires` lists for their year. `null` until then.
   */
  @Prop({ type: Date, default: null })
  leftAt!: Date | null;

  /**
   * **`FIRST_SALE_DATE`: the day of this person's first sale since joining** (ADR-0171 §1, P18.8-T4 AC-1) — an office
   * date, the earliest of a sales lead reaching *Paid and issued*, a closing logged by a checklist tick, and — failing
   * both — the production file's first month with a policy. Computed by `firstSaleOf` and written by
   * `FirstSaleService` from the leads, the production file and migration 0042; **it only ever moves earlier**: a
   * lead deleted or moved back, or an import reverted, leaves it where it is. `null` until there is one.
   */
  @Prop({ type: String, default: null })
  firstSaleDate!: string | null;

  /** Where the first sale came from: `lead`, `manual` (a checklist tick) or `monthly_file`. `null` with no date. */
  @Prop({ type: String, enum: [...FIRST_SALE_SOURCES, null], default: null })
  firstSaleSource!: FirstSaleSource | null;

  /** The record it came from: a lead, or the production file's month row. Both `null` with no date. */
  @Prop({ type: String, enum: ['leads', 'monthlyAgentData', null], default: null })
  firstSaleRecordCollection!: FirstSaleRecordCollection | null;

  @Prop({ type: String, default: null })
  firstSaleRecordId!: string | null;

  /**
   * **`ACTIVATION_3M`, kept once decided** (ADR-0171 §2, P18.8-T6 AC-1; `metrics-and-definitions.md`, *3M
   * activation*): `activated` or `not_activated` — decided after day 90 of the join date, or on the day a new hire
   * left within it — and **never written over**, so a closing logged later with an earlier day, a production file
   * uploaded late or a corrected join date moves nothing. `null` while in progress, for an existing agent, and for a
   * decided result nothing has kept yet, which `activation3MOf` computes the same. Written by `Activation3MService`
   * alone, in a conditional write on `null`: before any write that would change its inputs, by *Mark left*, and by
   * the `/new-hires` read.
   */
  @Prop({ type: String, enum: [...ACTIVATION_3M_LOCKS, null], default: null })
  activation3M!: Activation3MLock | null;

  /** When the result was kept. `null` with none. */
  @Prop({ type: Date, default: null })
  activation3MLockedAt!: Date | null;

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

  /**
   * ***Full-time* or *part-time*: how this person works in this office** (ADR-0158 §1, P18.5-T4).
   *
   * On the membership, not the account, because somebody may work one way here and another way in an
   * office they join later. **Optional**: a member who arrived before it has none, which a screen reads
   * as *Not recorded*, and they set it on `/profile`. Written by the roster import from its
   * `workStatus` column, and copied by `HierarchyService` from `users.registeredWorkStatus` — what a
   * person said when they registered — onto whichever membership they are given. The person's own to
   * change (`PATCH /auth/me`); the Owner and the Admins read it on the person page.
   */
  @Prop({ type: String, enum: [...WORK_STATUSES, null], default: null })
  workStatus!: WorkStatus | null;

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

  /**
   * **When this person's latest invitation was sent** (ADR-0212 §2; P19.4-T3 AC-6): the one-time link to choose a
   * password, emailed to an Owner a KPM was made with (or given by *Ganti pemilik*, or sent again by *Kirim ulang
   * undangan*) and to each new person a member import invites (ADR-0205 §10). `null`: no invitation was sent.
   *
   * What *Diundang* reads — sent, and the account not yet signed in (`users.lastLoginAt`) — on the Owner's card, on
   * `/admin/tenants` and in *All members* (ADR-0207). On the membership because an invitation is to this office.
   */
  @Prop({ type: Date, default: null })
  invitedAt!: Date | null;

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
