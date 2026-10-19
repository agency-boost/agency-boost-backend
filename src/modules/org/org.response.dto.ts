import { ApiProperty } from '@nestjs/swagger';
import type { DirectoryMember, DirectoryPage } from './directory.service';
import type { GroupSummary, MemberTags } from './group.service';
import type { KpmDirectoryEntry, LeaderChoice, JoinState } from './onboarding.service';
import type { PendingRequest, RoutingChoice, UntaggedMember } from './approvals.service';
import type { DelegatedAdmin } from './admin-delegation.service';
import type { TeamMember, RoleChangeEntry } from './role-change.service';
import type { InvitePreview, MyLeaderCode } from './leader-code.service';
import type { OrgTreeNode, OrgTreeLeader, OrgTree } from './org-tree.service';
import type { HierarchyRole, MembershipStatus } from './membership.schema';

/**
 * The organisation module's response shapes, as documented classes.
 *
 * Each `implements` the interface its service returns, so a field added to one and not
 * the other is a compile error rather than a hole in the contract. See
 * `tenants/tenant.response.dto.ts` for why interfaces alone cannot do this.
 */
/** The tab counts on the roster: `Directory (187)`, `Pending (14)`, `Removed (3)`. */
export class DirectoryCountsDto {
  @ApiProperty({ type: Number })
  directory!: number;

  @ApiProperty({ type: Number })
  pending!: number;

  @ApiProperty({ type: Number })
  removed!: number;
}

/**
 * Direct reports split by rung. A total alone cannot be rendered as the prototype's
 * sentence — *"3 direct agents, 2 AAB"* — so the split travels rather than being
 * recomputed per node.
 */
export class RoleCountsDto {
  @ApiProperty({ type: Number })
  ab!: number;

  @ApiProperty({ type: Number })
  aab!: number;

  @ApiProperty({ type: Number })
  agent!: number;

  @ApiProperty({ type: Number, description: 'What makes somebody a leader (OD-23) — the rung does not.' })
  total!: number;
}

export class DirectoryMemberDto implements DirectoryMember {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: String, enum: ['active', 'pending', 'removed'] })
  status!: MembershipStatus;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  preferredName!: string | null;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String, nullable: true })
  leaderId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  leaderName!: string | null;

  @ApiProperty({ type: Number })
  depth!: number;

  @ApiProperty({ type: Number })
  directCount!: number;

  @ApiProperty({ type: Number })
  subtreeCount!: number;

  @ApiProperty({ type: Boolean })
  isLeader!: boolean;

  @ApiProperty({ type: Boolean })
  isKpmOwner!: boolean;

  @ApiProperty({ type: Boolean })
  isKpmAdmin!: boolean;

  @ApiProperty({ type: String, nullable: true })
  joinedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  removedAt!: string | null;

  /*
   * *Last activity* and *Last coached* (D-directory): on every row of `GET /members` — the roster — and on no
   * other read of a member, which is why they are optional here. The page's read records one §3.5 entry per
   * member on it (`DirectoryColumns`).
   */
  @ApiProperty({
    type: String, nullable: true, required: false, example: '2026-10-07',
    description: 'On the roster’s **active** rows only — absent on the Pending and Removed tabs: their latest day logged, in the agency’s calendar; `null` is *Never*.',
  })
  lastActivityOn?: string | null;

  @ApiProperty({
    type: Number, nullable: true, required: false, example: 2,
    description: 'On the roster’s active rows only: whole days since it — 0 is *Today*; `null` is *Never*.',
  })
  lastActivityDays?: number | null;

  @ApiProperty({
    type: Number, nullable: true, required: false, example: 12,
    description: 'On the roster’s active rows only: `DAYS_SINCE_LAST_COACHING`, as the coaching roster serves it; `null` is *Never*, no 1:1 yet.',
  })
  lastCoachedDays?: number | null;

  @ApiProperty({ type: Boolean, description: 'May **this viewer** move this person between Agent and AAB. A direct leader may; so may the office. Decides what is offered, never what is allowed — the API refuses regardless.' })
  canChangeRole!: boolean;

  @ApiProperty({ type: Boolean, description: 'May they involve the AB rung. The office only — a leader cannot make somebody their own peer.' })
  canPromoteToAb!: boolean;

  @ApiProperty({ type: Boolean, description: 'May they remove this person. False for yourself, for the office root, and for anybody already removed.' })
  canRemove!: boolean;
}

export class DirectoryPageDto implements DirectoryPage {
  @ApiProperty({ type: () => DirectoryMemberDto, isArray: true })
  members!: DirectoryMember[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty({ type: () => DirectoryCountsDto })
  counts!: { directory: number; pending: number; removed: number };

}

export class GroupSummaryDto implements GroupSummary {
  @ApiProperty({ type: String })
  groupId!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  ownerMembershipId!: string;

  @ApiProperty({ type: String })
  ownerName!: string;

  @ApiProperty({ type: Boolean, description: 'The owner has been removed from the office. They are still named — they really are the recorded owner, and a blank would look like a fault. But an Owner reading the list needs to know the group has nobody running it, so the flag travels and the screen says both.' })
  ownerHasLeft!: boolean;

  @ApiProperty({ type: Number })
  memberCount!: number;

}

export class MemberTagsDto implements MemberTags {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, isArray: true })
  groupIds!: string[];

  @ApiProperty({ type: Boolean })
  isCoreLeader!: boolean;

}

export class KpmDirectoryEntryDto implements KpmDirectoryEntry {
  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  branchName!: string;

  @ApiProperty({ type: String, description: 'The insurer, named and identified. The id travels because somebody whose branch is not on the platform has to say which company they would belong to, and the directory is the only place a newcomer can learn which companies exist. It names no office and leaks nothing an outsider could not read from the list itself.' })
  companyId!: string;

  @ApiProperty({ type: String })
  companyName!: string;

  @ApiProperty({ type: String, nullable: true })
  city!: string | null;

}

export class LeaderChoiceDto implements LeaderChoice {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ enum: ['ab', 'aab'], type: String })
  role!: 'ab' | 'aab';

  @ApiProperty({ type: Number })
  unitSize!: number;

  @ApiProperty({ type: Boolean })
  isCurrentLeader!: boolean;

  @ApiProperty({ type: Boolean })
  requestSent!: boolean;

}

export class JoinStateDto implements JoinState {
  @ApiProperty({ type: String, nullable: true })
  kpmId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  kpmLabel!: string | null;

  @ApiProperty({ type: String, nullable: true })
  registeredAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  leaderMembershipId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  leaderName!: string | null;

  @ApiProperty({ enum: ['none', 'pending', 'active', 'removed'], type: String })
  status!: 'none' | 'pending' | 'active' | 'removed';

  @ApiProperty({ type: String, nullable: true })
  pendingRequestTo!: string | null;

}

export class PendingRequestDto implements PendingRequest {
  @ApiProperty({ type: String })
  requestId!: string;

  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: String })
  requestedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  routedFromName!: string | null;

  @ApiProperty({ type: String, description: 'The leader this request names — which is who the joiner joins if it is approved with no destination, and whose sub-units are the destinations on offer. For a leader reading their own inbox this is always themselves. For the Owner or an Admin reading the office queue it differs per row, and the screen cannot render the destination list — or say plainly where an approval sends somebody — without it.' })
  leaderMembershipId!: string;

  @ApiProperty({ type: String })
  leaderName!: string;

}

export class RoutingChoiceDto implements RoutingChoice {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: Number })
  unitSize!: number;

  @ApiProperty({ type: String, description: "The leader whose sub-unit this is. A leader's inbox holds only requests addressed to them, so one list served every row. A tenant admin's inbox is the whole office, where each row names a different leader — and `approve()` validates the destination against **the requested leader**, not the actor. So a single list was not merely imprecise there, it was unusable: every choice it offered was refused with `422`." })
  forLeaderMembershipId!: string;

}

export class UntaggedMemberDto implements UntaggedMember {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

}

export class DelegatedAdminDto implements DelegatedAdmin {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: String, nullable: true })
  grantedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  grantedByName!: string | null;

  @ApiProperty({ type: Boolean })
  canRevoke!: boolean;

}

export class TeamMemberDto implements TeamMember {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: Number })
  directCount!: number;

  @ApiProperty({ type: Boolean, description: "Whether this viewer may change *this* person's role. Sent rather than inferred, because the rule is a server rule and the screen should not carry a second copy of it that can drift." })
  canChangeRole!: boolean;

}

export class RoleChangeEntryDto implements RoleChangeEntry {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'], nullable: true })
  fromRole!: HierarchyRole | null;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'], nullable: true })
  toRole!: HierarchyRole | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  actorName!: string | null;

  @ApiProperty({ type: String })
  changedAt!: string;

}

/**
 * The leader's own code. Two fields, because there is no lifecycle to describe any more.
 *
 * This was `IssuedInviteDto` and carried `label`, `autoApprove`, `maxUses`, `useCount`,
 * `expiresAt`, `revokedAt` and a derived `state` — every one of them a way to bound a
 * credential somebody could mint again (P3.6-T1).
 */
export class MyLeaderCodeDto implements MyLeaderCode {
  @ApiProperty({ type: String, example: 'JOR417' })
  code!: string;

  @ApiProperty({ type: String, description: 'The shareable form. The QR encodes exactly this.' })
  url!: string;
}

export class InvitePreviewDto implements InvitePreview {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  kpmLabel!: string;

  @ApiProperty({ type: String })
  leaderName!: string;

}

export class OrgTreeNodeDto implements OrgTreeNode {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  preferredName!: string | null;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: Number })
  depth!: number;

  @ApiProperty({ type: Number, description: "Depth **within this projection**, one-based — the number on the column label. Not the same as `depth + 1`, and that is the whole point of sending it. An AB two layers down the office is *Layer 1* of their own tree, because AC-1 says layer one is you. Computing it here keeps one coordinate frame: a client that subtracted its own root's depth would be a second one, and the two disagree the moment a projection has roots at different depths." })
  layer!: number;

  @ApiProperty({ type: String, nullable: true })
  leaderId!: string | null;

  @ApiProperty({ type: Number })
  directCount!: number;

  @ApiProperty({ type: () => RoleCountsDto })
  directCounts!: { ab: number; aab: number; agent: number; total: number };

  @ApiProperty({ type: Number })
  subtreeCount!: number;

  @ApiProperty({ type: Boolean })
  isLeader!: boolean;

  @ApiProperty({ type: Boolean })
  isSelf!: boolean;

}

export class OrgTreeLeaderDto implements OrgTreeLeader {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

}

export class OrgTreeDto implements OrgTree {
  @ApiProperty({ type: () => OrgTreeNodeDto, isArray: true })
  nodes!: OrgTreeNode[];

  @ApiProperty({ type: () => OrgTreeLeaderDto, nullable: true })
  leader!: OrgTreeLeader | null;

  @ApiProperty({ type: String, isArray: true })
  rootIds!: string[];

  @ApiProperty({ type: String, nullable: true })
  selfId!: string | null;

  @ApiProperty({ type: () => RoleCountsDto })
  counts!: { ab: number; aab: number; agent: number; total: number };

}

