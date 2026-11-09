import { ApiProperty } from '@nestjs/swagger';
import type { DirectoryMember, DirectoryPage, MemberPersonal, MemberSearchHit } from './directory.service';
import type { MemberPhone } from './member-phone.service';
import type { Gender, WorkStatus } from '@/domain/constants';
import type { GroupSummary, MemberTags } from './group.service';
import type { KpmDirectoryEntry, LeaderChoice, JoinState } from './onboarding.service';
import type { PendingRequest, RoutingChoice, UntaggedMember } from './approvals.service';
import type { DelegatedAdmin } from './admin-delegation.service';
import type { TeamMember, RoleChangeEntry } from './role-change.service';
import type { LeaderLimitRequestRow } from './leader-limit-request.service';
import type { LeaderLimitAction, LeaderLimitRequestStatus } from './leader-limit-request.schema';
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

/** What a person records (ADR-0158), on one member's read, to the Owner, an Admin or the person. */
export class MemberPersonalDto implements MemberPersonal {
  @ApiProperty({ type: String, nullable: true, example: '1990-03-15', description: '`YYYY-MM-DD`. `null` is *Not recorded*.' })
  dateOfBirth!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['male', 'female'] })
  gender!: Gender | null;

  @ApiProperty({ type: String, nullable: true, example: '2021-07', description: '`YYYY-MM`: the month they joined the insurer.' })
  companyJoinMonth!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['full_time', 'part_time'], description: 'How they work in this office.' })
  workStatus!: WorkStatus | null;

  @ApiProperty({
    type: String, nullable: true, example: 'Prudential',
    description: 'The office’s company, which the page names beside the company join month: *Bergabung di Prudential*.',
  })
  companyName!: string | null;
}

export class DirectoryMemberDto implements DirectoryMember {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({
    type: String,
    example: 'AAB',
    description: 'The rung they stand on, by its code on the company\u2019s ladder. `role` is the class it gives.',
  })
  orgLevelCode!: string;

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

  @ApiProperty({
    type: Boolean,
    description:
      'A Core Leader now (ADR-0159 §1): tagged, on a leader rung — the effective flag. A member tagged and since moved '
      + 'off a leader rung reads `false` here, and their tag stays on `GET /members/:id/tags`.',
  })
  isCoreLeader!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether this viewer may tag or untag this member *Core Leader* from the row: they hold '
      + '`member:tag_core_leader`, and the member stands on a leader rung and has not left (ADR-0159 §1). An offer, '
      + 'never the gate: `PUT /members/:id/core-leader` refuses regardless.',
  })
  canTagCoreLeader!: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'The system’s stamp: the instant the membership was made active.' })
  joinedAt!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-07-14',
    description:
      'The person’s **join date** in this office, an office date their leader gave (ADR-0169): what *Join date* '
      + 'prints. `null` while they are pending.',
  })
  joinDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  removedAt!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-09-30',
    description:
      'The office date the person **came back** to this office, if they did: on a live membership that follows a '
      + 'removed one of the same person, its own join date — the directory’s *Rejoined*; on a removed membership the '
      + 'person has since returned from, the later membership’s join date — *Rejoined {date}*. `null` otherwise, and '
      + 'while the later membership is pending. Read only from memberships this reader may see.',
  })
  rejoinedOn!: string | null;

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

  @ApiProperty({
    type: () => MemberPersonalDto, required: false,
    description: 'On `GET /members/:membershipId` only, and only to the office’s Owner, an Admin, or the person '
      + 'themselves (ADR-0158 §6): their birth date, gender, company join month and work status. Absent on '
      + 'the roster and on a leader’s read.',
  })
  personal?: MemberPersonal;
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

  @ApiProperty({ type: Boolean, description: 'The tag as stored. It has effect only while `canBeCoreLeader` (ADR-0159 §1).' })
  isCoreLeader!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Their rung is a leader rung, so the tag may be set and has effect (ADR-0159 §1). False for an Agent, whose tag '
      + 'is refused `CORE_LEADER_NOT_A_LEADER`, and for a member tagged and since moved off a leader rung.',
  })
  canBeCoreLeader!: boolean;

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

  @ApiProperty({
    type: String,
    example: 'AAB',
    description: 'The rung they stand on, by its code on the company\u2019s ladder. `role` is the class it gives.',
  })
  orgLevelCode!: string;

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
 * credential somebody could mint again (P3.2-T1).
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

  @ApiProperty({ type: Number, description: "UI V1 (UI-059, O-5): this person's activity count today — the office's day (Asia/Jakarta), the total Activity Management saved for it; 0 when nothing was logged. The Group Tree's *n aktivitas* / *Belum lapor* pill." })
  todayActivityCount!: number;

  @ApiProperty({ type: String, nullable: true, description: 'UI V1 (UI-059): their profile photo, when they have one (`users.avatarUrl`); the row draws initials otherwise.' })
  photoUrl!: string | null;

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


/** A leader past the office's limit, waiting for AgencyBoost — or decided (ADR-0157). */
export class LeaderLimitRequestRowDto implements LeaderLimitRequestRow {
  @ApiProperty({ type: String })
  requestId!: string;

  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({ type: String, example: '0417' })
  kpmCode!: string;

  @ApiProperty({ type: String, example: 'Cempaka Putih' })
  kpmBranchName!: string;

  @ApiProperty({ type: String })
  subjectMembershipId!: string;

  @ApiProperty({ type: String })
  subjectName!: string;

  @ApiProperty({ type: String })
  subjectAgentCode!: string;

  @ApiProperty({ type: String, enum: ['promote', 'activate'] })
  action!: LeaderLimitAction;

  @ApiProperty({ type: String, description: 'The rung they stood on when it was asked, by code.' })
  fromOrgLevelCode!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The rung asked for, for `promote`.' })
  toOrgLevelCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The office\u2019s reason, for `promote`.' })
  reason!: string | null;

  @ApiProperty({ type: String })
  requestedByMembershipId!: string;

  @ApiProperty({ type: String })
  requestedByName!: string;

  @ApiProperty({ type: String, enum: ['pending', 'approved', 'declined', 'cancelled'] })
  status!: LeaderLimitRequestStatus;

  @ApiProperty({ type: String })
  requestedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'AgencyBoost\u2019s reason, or that it no longer applied.' })
  declineReason!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'The office\u2019s leader limit now; `null` for none.' })
  maxLeaders!: number | null;

  @ApiProperty({ type: Number, description: 'The office\u2019s Leaders used now.' })
  leadersUsed!: number;
}

/** One person *Search agent* offers (UI V1, 2026-10-30; UI-012, UI-059, D-14). */
export class MemberSearchHitDto implements MemberSearchHit {
  @ApiProperty({ type: String, description: 'The membership the pick opens: `/coaching/{membershipId}/summary`.' })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  preferredName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  agentCode!: string | null;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: String, description: 'The rung, by its ladder code; `role` is the class it gives.' })
  orgLevelCode!: string;
}

/** *Search agent*'s answer: the people in reach who match, A to Z by name, the first `limit`. */
export class MemberSearchResultDto {
  @ApiProperty({ type: () => MemberSearchHitDto, isArray: true })
  members!: MemberSearchHit[];
}

/** A person's WhatsApp number, as their leader saved it (UI V1, 2026-10-30; UI-081, D-22). */
export class MemberPhoneDto implements MemberPhone {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String, example: '+6281211002200', description: 'As stored: `+62` and 9 to 13 digits.' })
  phone!: string;
}

/** UI V1 (UI-085): how many join requests are waiting on the reader — the *Pending Requests* tab's count. */
export class WaitingRequestCountDto {
  @ApiProperty({
    type: Number, example: 2,
    description: 'Requests waiting on you, as `GET /join/requests` lists them; the office\'s whole queue for the Owner or an Admin.',
  })
  count!: number;
}
