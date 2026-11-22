import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import type { ResourceName } from '@/common/errors/resources';

/**
 * **Who looks after a KPM** (ADR-0268 §1; P19.17 F2; `revisions/2026-11-19/PERMISSIONS.md`).
 *
 * Four kinds of person hold the KPM Owner's rights in **KPM** (Overview with its targets and groups, Advanced analytics,
 * the Strategic Leader Forum, Data upload) and **Pengaturan**, and see the whole KPM in **People**:
 *
 * - `super_admin` — the AgencyBoost platform team, **inside** a KPM (`RequestContext.isSuperAdminInKpm`, the request's
 *   `X-Kpm-Id`): the Owner in every KPM, no limits, no approval, every write audited with them as the actor;
 * - `kpm_owner` — the KPM's Owner;
 * - `kpm_admin` — the same as the Owner, except adding or removing admins (`kpm_admin:grant`, `kpm_admin:revoke`);
 * - `core_leader` — an AB or AAB tagged *Core leader* (`RequestContext.isCoreLeader`): the Owner's rights in KPM and
 *   Pengaturan, but in People they **open, edit and approve moves only for their own downline**. They never make or
 *   remove core leaders, never remove a member from the KPM and never see the KPM admins.
 *
 * The permission matrix says *whether* (`CORE_LEADER` in `permissions.ts`); this module says **how far** for the one
 * steward whose reach is not the whole KPM. Every service of KPM, Pengaturan and People asks it rather than reading
 * `membership.isKpmOwner` itself, so a Super Admin inside the KPM and a core leader are never forgotten by one of them.
 *
 * A support session (*Lihat sebagai*) as an Owner is a steward too — it shows what the Owner sees — and writes nothing:
 * `ViewOnlySessionGuard` and `can()` refuse its writes before any service is reached.
 */
export type OfficeStewardKind = 'super_admin' | 'kpm_owner' | 'kpm_admin' | 'core_leader';

/** Which steward this request is, or `null` for everybody else — a field member, an Agent, a Super Admin in no KPM. */
export function officeStewardKind(ctx: RequestContext): OfficeStewardKind | null {
  if (ctx.isSuperAdminInKpm) return 'super_admin';
  const member = ctx.membership;
  if (member?.status !== 'active') return null;
  if (member.isKpmOwner) return 'kpm_owner';
  if (member.isKpmAdmin) return 'kpm_admin';
  return ctx.isCoreLeader ? 'core_leader' : null;
}

/** **Is this request a KPM's steward** — Super Admin inside it, its Owner, an Admin, or a core leader? */
export function isOfficeSteward(ctx: RequestContext): boolean {
  return officeStewardKind(ctx) !== null;
}

/**
 * **A steward whose reach is the whole KPM**: the Super Admin inside it, the Owner, an Admin — every steward but a core
 * leader, whose People reach is their own downline.
 */
export function stewardsWholeOffice(ctx: RequestContext): boolean {
  const kind = officeStewardKind(ctx);
  return kind !== null && kind !== 'core_leader';
}

/**
 * **The second wall of a steward's route**: the KPM's id, or a refusal. A request in no KPM — a Super Admin who has not
 * entered one, somebody who has joined none — is `403 TENANT_NO_MEMBERSHIP`; a member of the KPM who is not a steward is
 * **`404 NOT_FOUND`** naming `resource`, the forum's and KPM analytics' rule (ADR-0159 §2): a refusal never says there
 * is something they are kept from.
 */
export function requireOfficeSteward(ctx: RequestContext, resource: ResourceName = 'KPM'): string {
  if (!ctx.kpmId) throw new NoMembershipException();
  if (!isOfficeSteward(ctx)) throw new NotFoundException(resource);
  return ctx.kpmId;
}

/**
 * A member as the downline rule reads them: their membership id and their uplines, nearest first or not
 * (`memberships.ancestorIds`). Ids as strings or ObjectIds — both are compared as strings.
 */
export interface MemberInReach {
  readonly membershipId: string | { toString(): string };
  readonly ancestorIds?: readonly (string | { toString(): string })[] | null;
}

function isBelow(me: string, target: MemberInReach): boolean {
  return (target.ancestorIds ?? []).some((id) => String(id) === me);
}

/**
 * **May this steward open this member** — their detail sheet, their profile, a row's chevron (ADR-0268 §1)? The Super
 * Admin inside the KPM, the Owner and an Admin: anybody in it. A core leader: **themselves and their own downline**;
 * every other row is shown, muted, and carries `openable: false`. Not a steward: `false` — their own reach is their
 * unit's, decided by the permission's scope, not here.
 */
export function canOpenMember(ctx: RequestContext, target: MemberInReach): boolean {
  const kind = officeStewardKind(ctx);
  if (kind === null) return false;
  if (kind !== 'core_leader') return true;
  const me = ctx.membershipId as string;
  return String(target.membershipId) === me || isBelow(me, target);
}

/**
 * **May this steward change this member** — edit a field in the detail sheet, change their role or leader, decide a move
 * request about them (ADR-0268 §1, amending ADR-0170 §4 and ADR-0247)? As `canOpenMember`, except that a core leader's
 * reach is **strictly below them**: a core leader never moves or edits themselves through the KPM's People pages.
 */
export function canManageMember(ctx: RequestContext, target: MemberInReach): boolean {
  const kind = officeStewardKind(ctx);
  if (kind === null) return false;
  if (kind !== 'core_leader') return true;
  return isBelow(ctx.membershipId as string, target);
}

/** `canOpenMember`, or **`404 NOT_FOUND`** naming `resource` — a member outside a core leader's downline is not confirmed. */
export function requireOpenableMember(ctx: RequestContext, target: MemberInReach, resource: ResourceName = 'Member'): void {
  if (!canOpenMember(ctx, target)) throw new NotFoundException(resource);
}

/** `canManageMember`, or **`404 NOT_FOUND`** naming `resource`. */
export function requireManageableMember(ctx: RequestContext, target: MemberInReach, resource: ResourceName = 'Member'): void {
  if (!canManageMember(ctx, target)) throw new NotFoundException(resource);
}
