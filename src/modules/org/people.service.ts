import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { canOpenMember, requireOfficeSteward, requireOpenableMember } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { render } from '@/common/i18n/sentence';
import { LEADER_CLASSES } from '@/domain/constants';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { RosterImportRecordRepository } from '@/modules/tenants/roster-import-record.schema';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { ApprovalsService } from './approvals.service';
import { NOT_A_TEST_ACCOUNT } from './counted-members';
import { DirectoryService, type DirectoryMember } from './directory.service';
import type { MembershipHistoryDocument } from './membership-history.schema';
import { MembershipRepository } from './membership.repository';
import type { HierarchyRole } from './membership.schema';
import { ORG_MESSAGES } from './org.messages';
import { MembershipHistoryRepository } from './org.repositories';

/** *Riwayat*'s filter (P19.20-T1 AC-4): *Semua · Perubahan peran · Dikeluarkan · Pindah unit*. */
export const PEOPLE_HISTORY_KINDS = ['all', 'role', 'removed', 'moved'] as const;
export type PeopleHistoryFilter = (typeof PEOPLE_HISTORY_KINDS)[number];
/** What one line of *Riwayat* is: a role change, a removal, a move to another leader, or a return. */
export type PeopleHistoryKind = 'role' | 'removed' | 'moved' | 'rejoined';

/** The hierarchy's events each kind reads (`membershipHistory.eventType`). */
const EVENTS: Record<PeopleHistoryKind, string> = {
  role: 'role_changed', removed: 'removed', moved: 're_parented', rejoined: 'reinstated',
};
const KIND_OF: Record<string, PeopleHistoryKind> = Object.fromEntries(
  Object.entries(EVENTS).map(([kind, event]) => [event, kind as PeopleHistoryKind]),
);

/** At most this many lines, newest first: *Riwayat* is the recent past, the audit log the whole of it. */
export const PEOPLE_HISTORY_LIMIT = 200;
/** *Riwayat unggah*: the last this many files. */
export const ROSTER_IMPORTS_SHOWN = 20;

/** One line of *Riwayat* (P19.20-T1 AC-4). */
export interface PeopleHistoryEntry {
  /** The history row's id. */
  id: string;
  kind: PeopleHistoryKind;
  membershipId: string;
  fullName: string;
  agentCode: string;
  /** Their class now, for the AB / AAB label before the name. */
  role: HierarchyRole;
  photoUrl: string | null;
  /** A role change's rungs, by class: *Agent → AAB*. */
  fromRole: HierarchyRole | null;
  toRole: HierarchyRole | null;
  /** A move's leaders, by name: *pindah dari SATRIA NUGRAHA ke AGUS PRASETYO*. */
  fromLeaderName: string | null;
  toLeaderName: string | null;
  /** What whoever acted wrote, if anything. */
  reason: string | null;
  /** *oleh …*: the member who acted, or the Super Admin by their account; `null` for nobody recorded. */
  actorName: string | null;
  at: string;
  /** This reader may open their sheet: a live membership in their reach (ADR-0268 §1). */
  openable: boolean;
}

/** The three tiles of *KPM admins* (P19.20-T4 AC-1): who owns the KPM, and how many admins and core leaders it has. */
export interface KpmStewards {
  owner: { membershipId: string; fullName: string; agentCode: string; role: HierarchyRole; photoUrl: string | null } | null;
  admins: number;
  coreLeaders: number;
}

/** One saved file of *Riwayat unggah* (P19.20-T5 AC-3). */
export interface RosterImportView {
  importId: string;
  fileName: string | null;
  importedAt: string;
  /** Who saved it, by name; `null` when nobody can be named. */
  byName: string | null;
  created: number;
  updated: number;
  invited: number;
  skipped: number;
}

/**
 * **The reads and the one write of *People* that no other service answers** (P19.20; ADR-0273): *All members › Riwayat*,
 * the three tiles of *KPM admins*, *Pilih leader* for somebody who registered and is in no unit, and *Riwayat unggah*.
 *
 * Every one is a steward's (`requireOfficeSteward`, ADR-0268 §4): the Super Admin inside the KPM, the Owner, an Admin and
 * a core leader — each route's permission first, then this. Everything through the tenant repositories, so another
 * office's row is never found (invariant §1); **test accounts are never listed or counted** (ADR-0267 §1).
 */
@Injectable()
export class PeopleService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly directory: DirectoryService,
    private readonly approvals: ApprovalsService,
    @Optional() @Inject(RosterImportRecordRepository) private readonly records: RosterImportRecordRepository | null = null,
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  /**
   * **`GET /people/history`** — *Riwayat* (P19.20-T1 AC-4): the old *Removed* and *Role change log* in one list, newest
   * first, with the moves to another leader and the returns — read from `membershipHistory`, where the before and after
   * of a rung and a leader live (`domain-invariants.md` §5). `kind` narrows it to one; *Semua* is all four.
   */
  async list(ctx: RequestContext, kind: PeopleHistoryFilter = 'all'): Promise<PeopleHistoryEntry[]> {
    requireOfficeSteward(ctx, 'Membership');
    const events = kind === 'all' ? Object.values(EVENTS) : [EVENTS[kind]];
    const rows = await this.history.find(
      ctx, { eventType: { $in: events } }, { sort: { validFrom: -1, _id: -1 }, limit: PEOPLE_HISTORY_LIMIT },
    );
    if (rows.length === 0) return [];

    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.membershipId);
      for (const other of [r.fromLeaderId, r.toLeaderId, r.actorMembershipId]) if (other) ids.add(other);
    }
    const memberships = await this.members.find(ctx, { _id: { $in: [...ids] } });
    const byId = new Map(memberships.map((m) => [String(m._id), m]));
    const userIds = new Set<string>(memberships.map((m) => m.userId));
    for (const r of rows) if (!r.actorMembershipId && r.actorUserId) userIds.add(r.actorUserId);
    const users = await this.users.find({ _id: { $in: [...userIds] } }).select('fullName avatarUrl').exec();
    const userById = new Map(users.map((u) => [String(u._id), u]));
    const photos = this.avatarLinks
      ? await this.avatarLinks.linksFor(users.map((u) => u.avatarUrl))
      : new Map<string, string>();
    const unknown = render(ORG_MESSAGES.unknownName, ctx.reader);
    const nameOf = (membershipId: string | null): string | null => {
      const m = membershipId ? byId.get(membershipId) : undefined;
      return m ? (userById.get(m.userId)?.fullName ?? unknown) : null;
    };

    return rows.flatMap((r: MembershipHistoryDocument): PeopleHistoryEntry[] => {
      const subject = byId.get(r.membershipId);
      // A test account is never listed (ADR-0267 §1); a row whose member this office no longer holds says nothing.
      if (!subject || subject.testAccount === true) return [];
      const user = userById.get(subject.userId);
      return [{
        id: String(r._id),
        kind: KIND_OF[r.eventType],
        membershipId: r.membershipId,
        fullName: user?.fullName ?? unknown,
        agentCode: subject.agentCode,
        role: subject.role,
        photoUrl: photos.get(user?.avatarUrl ?? '') ?? null,
        fromRole: r.eventType === 'role_changed' ? r.fromRole : null,
        toRole: r.eventType === 'role_changed' ? r.toRole : null,
        fromLeaderName: r.eventType === 're_parented' ? nameOf(r.fromLeaderId) : null,
        toLeaderName: r.eventType === 're_parented' ? nameOf(r.toLeaderId) : null,
        reason: r.reason,
        actorName: r.actorMembershipId
          ? nameOf(r.actorMembershipId)
          : r.actorUserId ? (userById.get(r.actorUserId)?.fullName ?? null) : null,
        at: r.validFrom.toISOString(),
        openable: subject.status !== 'removed'
          && canOpenMember(ctx, { membershipId: String(subject._id), ancestorIds: subject.ancestorIds }),
      }];
    });
  }

  /**
   * **`GET /people/stewards`** — the three tiles of *KPM admins* (P19.20-T4 AC-1): the KPM's Owner by name, and how many
   * Admins and core leaders it has now. The Super Admin is never among them — they hold no membership here (ADR-0268 §3).
   */
  async stewards(ctx: RequestContext): Promise<KpmStewards> {
    requireOfficeSteward(ctx, 'KPM');
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).select('ownerUserId').exec();
    const live = { status: 'active', ...NOT_A_TEST_ACCOUNT };
    const [ownerRow, admins, coreLeaders] = await Promise.all([
      kpm?.ownerUserId ? this.members.findOne(ctx, { userId: kpm.ownerUserId, status: 'active' }) : Promise.resolve(null),
      this.members.count(ctx, { ...live, 'adminAccess.isKpmAdmin': true }),
      this.members.count(ctx, { ...live, isCoreLeader: true, role: { $in: [...LEADER_CLASSES] } }),
    ]);
    if (!ownerRow) return { owner: null, admins, coreLeaders };
    const user = await this.users.findOne({ _id: ownerRow.userId }).select('fullName avatarUrl').exec();
    const photo = this.avatarLinks ? await this.avatarLinks.linkFor(user?.avatarUrl) : null;
    return {
      owner: {
        membershipId: String(ownerRow._id),
        fullName: user?.fullName ?? render(ORG_MESSAGES.unknownName, ctx.reader),
        agentCode: ownerRow.agentCode,
        role: ownerRow.role,
        photoUrl: photo,
      },
      admins,
      coreLeaders,
    };
  }

  /**
   * **`PUT /people/:membershipId/placement`** — *Pilih leader* on *Sudah daftar, belum masuk unit* (P19.20-T1 AC-4): a
   * person who registered and is in no unit, put under the leader chosen, now — `ApprovalsService.placeUnder`, every
   * refusal a tag meets, the join date the office's today, their open request cancelled, their notice. A core leader
   * places under themselves or somebody in their downline only (`requireOpenableMember`, ADR-0268 §1). Answers the person
   * as the roster lists them.
   */
  async place(ctx: RequestContext, membershipId: string, leaderMembershipId: string): Promise<DirectoryMember> {
    requireOfficeSteward(ctx, 'Membership');
    const leader = await this.members.findOne(ctx, { _id: leaderMembershipId, status: 'active' });
    if (!leader) throw new NotFoundException('Membership');
    requireOpenableMember(ctx, { membershipId: String(leader._id), ancestorIds: leader.ancestorIds }, 'Membership');
    await this.approvals.placeUnder(ctx, membershipId, String(leader._id), undefined, 'tagged');
    return this.directory.readListed(ctx, membershipId);
  }

  /** **`GET /people/imports`** — *Riwayat unggah* (P19.20-T5 AC-3): the last files saved, newest first, by whom. */
  async imports(ctx: RequestContext): Promise<RosterImportView[]> {
    requireOfficeSteward(ctx, 'KPM');
    if (!this.records) return [];
    const rows = await this.records.find(ctx, {}, { sort: { importedAt: -1, _id: -1 }, limit: ROSTER_IMPORTS_SHOWN });
    if (rows.length === 0) return [];
    const actors = rows.map((r) => r.actorMembershipId).filter((id): id is string => !!id);
    const memberships = actors.length ? await this.members.find(ctx, { _id: { $in: [...new Set(actors)] } }) : [];
    const userOfMember = new Map(memberships.map((m) => [String(m._id), m.userId]));
    const userIds = new Set<string>([
      ...memberships.map((m) => m.userId),
      ...rows.map((r) => r.actorUserId).filter((id): id is string => !!id),
    ]);
    const users = await this.users.find({ _id: { $in: [...userIds] } }).select('fullName').exec();
    const nameOfUser = new Map(users.map((u) => [String(u._id), u.fullName]));
    return rows.map((r) => {
      const userId = (r.actorMembershipId && userOfMember.get(r.actorMembershipId)) || r.actorUserId;
      return {
        importId: String(r._id),
        fileName: r.fileName,
        importedAt: r.importedAt.toISOString(),
        byName: userId ? (nameOfUser.get(userId) ?? null) : null,
        created: r.created,
        updated: r.updated,
        invited: r.invited,
        skipped: r.skipped,
      };
    });
  }
}
