import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext, isEffectiveCoreLeader } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { DEFAULT_TENANT_TIMEZONE, LEADER_CLASSES } from '@/domain/constants';
import { withoutTestAccounts } from '@/modules/org/counted-members';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm, KpmDocument, type KpmOwner } from '@/modules/tenants/kpm.schema';
import { ownerUserIdsOf } from '@/modules/tenants/kpm-owners';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import type { EditorStanding, ForumEditor } from './leader-meeting.schema';
import { firstNameOf, type ForumPerson } from './leader-meeting.view';

/** What a forum route knows about its reader. */
export interface ForumReader {
  /** `null` for the Super Admin inside the KPM, who is no member of it (ADR-0268 §3). */
  membershipId: string | null;
  /** The Super Admin inside the KPM, the Owner or an Admin: an editor of every forum, whatever their tag. */
  office: boolean;
  /**
   * A *Core leader* **at this request** (roles §1.4, ADR-0159 §1) — tagged, on a leader rung, active — read from the
   * membership, never the token. A tagged member off a leader rung is not one.
   */
  tagged: boolean;
}

/** The reader's office, read once per request by its own `_id`. */
export interface ForumOffice {
  timezone: string;
  branch: string;
  /** Every owner's account, in order of `since` (ADR-0285 §3): each one an editor as the Owner. */
  ownerUserIds: string[];
  companyId: string | null;
}

/**
 * **The one answer every refusal of the forum gives** (ADR-0131 §7, roles §3.14 ¶): another office's forum, a
 * deleted one, an unknown, expired or revoked link, another office's link, and any route for a field member who is
 * no core leader — the same code and the same words, so nothing tells them apart.
 */
export function meetingNotFound(): NotFoundException {
  return new NotFoundException('Meeting');
}

/**
 * **Who reads the forum, and who may edit it** (D-coeditors, roles §1.4, §3.14; ADR-0268, ADR-0276).
 *
 * **The office's stewards are the editors** (`common/auth/office-steward.ts`): the **Super Admin inside the KPM**, the
 * Owner, the Admins, and every active member who is a *Core leader* — tagged, on a leader rung (ADR-0159 §1) — read
 * from the memberships on every request, so tagging somebody changes who may edit every forum at once. **Test accounts
 * are never among them** (ADR-0267 §1): not drawn, not counted, not offered as a PIC. Every read here is a fixed number
 * of queries, whatever the office's size.
 */
@Injectable()
export class LeaderMeetingPeople {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    /** The office's own row, by `_id` from the context: the scope is the id (`repositories.tenancy.spec.ts`). */
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {}

  /**
   * **Any reader of the office** — the Super Admin inside it, or one of its members — as a shared link is opened. A
   * Super Admin in no KPM, and anybody who has joined none: `TENANT_NO_MEMBERSHIP` (roles §3.14 §).
   */
  async reader(ctx: RequestContext): Promise<ForumReader> {
    if (!ctx.kpmId) throw new NoMembershipException();
    if (ctx.isSuperAdminInKpm) return { membershipId: null, office: true, tagged: false };
    if (!ctx.membership) throw new NoMembershipException();
    const office = ctx.membership.isKpmOwner || ctx.membership.isKpmAdmin;
    const row = await this.memberships.findById(ctx, ctx.membership.membershipId);
    return {
      membershipId: ctx.membership.membershipId,
      office,
      tagged: row?.status === 'active' && isEffectiveCoreLeader(row),
    };
  }

  /**
   * **A reader of the forum by its address** — the list, a forum, every write: a steward of the office. Anybody else
   * of it is answered **404 on every route** (¶): a refusal never confirms that a forum exists.
   */
  async editor(ctx: RequestContext): Promise<ForumReader> {
    const reader = await this.reader(ctx);
    if (!reader.office && !reader.tagged) throw meetingNotFound();
    return reader;
  }

  async office(ctx: RequestContext): Promise<ForumOffice> {
    const row = await this.kpms.findById(ctx.kpmId).select('timezone branchName owners companyId').lean().exec();
    const kpm = row as { timezone?: string; branchName?: string; owners?: KpmOwner[]; companyId?: string } | null;
    return {
      timezone: kpm?.timezone ?? DEFAULT_TENANT_TIMEZONE,
      branch: kpm?.branchName ?? '',
      ownerUserIds: ownerUserIdsOf(kpm),
      companyId: kpm?.companyId ?? null,
    };
  }

  /**
   * **The editors now** (D-coeditors): the owners — the active memberships of the office's owning accounts — then the
   * Admins, then every other core leader (tagged, on a leader rung), each once, by membership id and rung. No test
   * account (ADR-0267 §1).
   */
  async liveEditors(ctx: RequestContext, office: ForumOffice): Promise<ForumEditor[]> {
    const rows = await this.memberships.find(
      ctx,
      withoutTestAccounts({
        status: 'active',
        $or: [
          ...(office.ownerUserIds.length > 0 ? [{ userId: { $in: office.ownerUserIds } }] : []),
          { 'adminAccess.isKpmAdmin': true },
          // ADR-0159 §1: a core leader is tagged **and** a leader by rung; a tagged Agent is nobody's editor.
          { isCoreLeader: true, role: { $in: [...LEADER_CLASSES] } },
        ],
      }),
      { projection: { userId: 1, orgLevelCode: 1, role: 1, isCoreLeader: 1, adminAccess: 1 } },
    );
    // Every owner an editor as the Owner (ADR-0285 §3), in order of `since`.
    const owners = office.ownerUserIds.flatMap((id) => rows.filter((row) => row.userId === id));
    const editor = (row: (typeof rows)[number], as: EditorStanding): ForumEditor => ({
      membershipId: String(row._id), as, rungCode: row.orgLevelCode, tagged: isEffectiveCoreLeader(row),
    });
    const others = rows.filter((row) => !owners.includes(row));
    return [
      ...owners.map((row) => editor(row, 'owner')),
      ...others.filter((row) => row.adminAccess?.isKpmAdmin === true).map((row) => editor(row, 'admin')),
      ...others.filter((row) => row.adminAccess?.isKpmAdmin !== true && isEffectiveCoreLeader(row))
        .map((row) => editor(row, 'core_leader')),
    ];
  }

  /**
   * **Every person a read draws, in one pass**: the editors — offered as PICs (`pickable`) — and every other member
   * `named` as a PIC (an editor since untagged, say), with their names and photos in two queries and the company's
   * ladder in one. A membership gone from the office is left out: its line reads no PIC. Editors first in their order
   * (the Owner, the Admins, the core leaders), then the others by name.
   */
  async people(
    ctx: RequestContext, office: ForumOffice, editors: readonly ForumEditor[], named: readonly string[] = [],
  ): Promise<{ people: ForumPerson[]; coreLeaders: ForumPerson[] }> {
    const editorIds = editors.map((e) => e.membershipId);
    const others = [...new Set(named.filter((id) => !editorIds.includes(id)))];
    const otherRows = others.length
      ? await this.memberships.find(ctx, { _id: { $in: others } }, { projection: { orgLevelCode: 1, role: 1, isCoreLeader: 1 } })
      : [];
    const pictured = await this.names.pictured(ctx, [...editorIds, ...otherRows.map((r) => String(r._id))]);
    const ladder = office.companyId ? await this.orgLevels.list(ctx, office.companyId) : [];
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const person = (membershipId: string, rungCode: string, tagged: boolean, pickable: boolean): ForumPerson | null => {
      const found = pictured.get(membershipId);
      if (!found) return null;
      return {
        membershipId,
        name: found.name,
        firstName: firstNameOf(found.name),
        photoUrl: found.photoUrl ?? null,
        rung: { code: rungCode, label: labels.get(rungCode) ?? rungCode },
        isReader: membershipId === ctx.membershipId,
        tagged,
        pickable,
      };
    };
    const editorPeople = editors.map((e) => person(e.membershipId, e.rungCode, e.tagged, true)).filter((p): p is ForumPerson => p !== null);
    const otherPeople = otherRows
      .map((r) => person(String(r._id), r.orgLevelCode, isEffectiveCoreLeader(r), false))
      .filter((p): p is ForumPerson => p !== null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
    const byName = (a: ForumPerson, b: ForumPerson) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId);
    return {
      people: [...editorPeople, ...otherPeople],
      coreLeaders: editorPeople.filter((p) => p.tagged).sort(byName),
    };
  }
}
