import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import type { EditorStanding, FrozenEditor } from './leader-meeting.schema';
import type { ForumPerson, MeetingEditors } from './leader-meeting.view';

/** What a forum route knows about its reader. */
export interface ForumReader {
  membershipId: string;
  /** The Owner or an Admin: an editor of every meeting, whatever their tag (ADR-0028). */
  office: boolean;
  /** Tagged *Core Leader* **at this request** (roles §1.4) — read from the membership, never the token. */
  tagged: boolean;
}

/** The reader's office, read once per request by its own `_id`. */
export interface ForumOffice {
  timezone: string;
  /** *"BSD City Branch"*: the share dialog's hint names it. */
  branch: string;
  ownerUserId: string | null;
  companyId: string | null;
}

/**
 * **The one answer every refusal of the forum gives** (ADR-0131 §7, roles §3.14 ¶): another office's meeting, a
 * deleted one, an unknown, expired or revoked link, another office's link, and any route for a field member not
 * tagged — the same code and the same words, so nothing tells them apart.
 */
export function meetingNotFound(): NotFoundException {
  return new NotFoundException('Meeting');
}

/**
 * **Who reads the forum, and who may edit it** (D-coeditors, roles §1.4, §3.14).
 *
 * **The tag is the list.** The editors are the Owner, then the Admins (`adminAccess.isKpmAdmin`), then every other
 * active member tagged *Core Leader* — each person once — read from the memberships on every request, so tagging or
 * untagging somebody changes who may edit every meeting at once. Every read here is a fixed number of queries,
 * whatever the office's size: the reader's row, the office's row, the editors in one read, their names in two
 * (`MemberNames`) and the company's ladder in one.
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
   * The reader, by the meeting's address or by a link. A Super Admin outside a support session belongs to no
   * office: `TENANT_NO_MEMBERSHIP` (roles §3.14 §).
   */
  async reader(ctx: RequestContext): Promise<ForumReader> {
    if (!ctx.membership || !ctx.kpmId) throw new NoMembershipException();
    const row = await this.memberships.findById(ctx, ctx.membership.membershipId);
    return {
      membershipId: ctx.membership.membershipId,
      office: ctx.membership.isKpmOwner || ctx.membership.isKpmAdmin,
      tagged: row?.isCoreLeader === true,
    };
  }

  /**
   * **A reader of the forum by its address** — the list, a meeting, every write: the Owner, an Admin, or a member
   * tagged *Core Leader* now. Anybody else of the office is answered **404 on every route** (¶): a refusal never
   * confirms that a meeting exists. A shared link is read by `reader` alone.
   */
  async editor(ctx: RequestContext): Promise<ForumReader> {
    const reader = await this.reader(ctx);
    if (!reader.office && !reader.tagged) throw meetingNotFound();
    return reader;
  }

  async office(ctx: RequestContext): Promise<ForumOffice> {
    const row = await this.kpms.findById(ctx.kpmId).select('timezone branchName ownerUserId companyId').lean().exec();
    const kpm = row as { timezone?: string; branchName?: string; ownerUserId?: string | null; companyId?: string } | null;
    return {
      timezone: kpm?.timezone ?? DEFAULT_TENANT_TIMEZONE,
      branch: kpm?.branchName ?? '',
      ownerUserId: kpm?.ownerUserId ?? null,
      companyId: kpm?.companyId ?? null,
    };
  }

  /**
   * **The editors now** (D-coeditors), as the freeze writes them: the Owner — the active membership of the office's
   * owning account — then the Admins, then every other member tagged, each once, by membership id and rung.
   */
  async liveEditors(ctx: RequestContext, office: ForumOffice): Promise<FrozenEditor[]> {
    const rows = await this.memberships.find(
      ctx,
      {
        status: 'active',
        $or: [
          ...(office.ownerUserId ? [{ userId: office.ownerUserId }] : []),
          { 'adminAccess.isKpmAdmin': true },
          { isCoreLeader: true },
        ],
      },
      { projection: { userId: 1, orgLevelCode: 1, isCoreLeader: 1, adminAccess: 1 } },
    );
    const owner = office.ownerUserId ? rows.find((row) => row.userId === office.ownerUserId) ?? null : null;
    const editor = (row: (typeof rows)[number], as: EditorStanding): FrozenEditor => ({
      membershipId: String(row._id), as, rungCode: row.orgLevelCode, tagged: row.isCoreLeader === true,
    });
    const others = rows.filter((row) => row !== owner);
    return [
      ...(owner ? [editor(owner, 'owner')] : []),
      ...others.filter((row) => row.adminAccess?.isKpmAdmin === true).map((row) => editor(row, 'admin')),
      ...others.filter((row) => row.adminAccess?.isKpmAdmin !== true && row.isCoreLeader === true)
        .map((row) => editor(row, 'core_leader')),
    ];
  }

  /**
   * **Names and rungs for every list of editors a read serves, in one pass**: the names in two queries, the
   * company's ladder in one, however many meetings and people. Each list is then described by the function this
   * answers — the Owner first, the Admins and the Core Leaders each by name — and `coreLeaderCount` counts every
   * editor tagged but the Owner. An editor whose membership is gone from the office is left out.
   */
  async describer(
    ctx: RequestContext, office: ForumOffice, lists: readonly (readonly FrozenEditor[])[],
  ): Promise<{
    editors: (list: readonly FrozenEditor[], frozen: boolean) => MeetingEditors;
    nameOf: (membershipId: string) => string | null;
  }> {
    const ids = [...new Set(lists.flatMap((list) => list.map((e) => e.membershipId)))];
    const names = await this.names.byMembershipId(ctx, ids);
    const ladder = office.companyId ? await this.orgLevels.list(ctx, office.companyId) : [];
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const person = (e: FrozenEditor): ForumPerson => ({
      membershipId: e.membershipId,
      name: names.get(e.membershipId)!,
      rung: { code: e.rungCode, label: labels.get(e.rungCode) ?? e.rungCode },
      isReader: e.membershipId === ctx.membershipId,
      tagged: e.tagged,
    });
    const byName = (a: ForumPerson, b: ForumPerson) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId);
    return {
      editors: (list, frozen) => {
        const known = list.filter((e) => names.has(e.membershipId));
        const owner = known.find((e) => e.as === 'owner');
        return {
          owner: owner ? person(owner) : null,
          admins: known.filter((e) => e.as === 'admin').map(person).sort(byName),
          coreLeaders: known.filter((e) => e.as === 'core_leader').map(person).sort(byName),
          coreLeaderCount: known.filter((e) => e.as !== 'owner' && e.tagged).length,
          frozen,
        };
      },
      nameOf: (membershipId) => names.get(membershipId) ?? null,
    };
  }
}
