import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { GroupRepository } from '@/modules/org/org.repositories';

/** One of the office's custom groups as the analytics' *Lihat untuk* offers it: *Core Leader · Grup · 3 orang*. */
export interface OfficeGroup {
  groupId: string;
  name: string;
  /** The group's members today: tagged with it, status *Aktif*. A member who left is in no group's figures. */
  memberCount: number;
}

/**
 * **The office's custom groups, for KPM Analytics' group filter** (UI-152 phase 2, Overview R5, OD-258;
 * [ADR-0204](../../../../docs/04-adr/0204-the-owner-reads-one-production-total-and-one-team-size-on-every-page.md) §4).
 *
 * The groups are *All members → Groups* (`groups`, `memberships.groupIds`), read here through the two tenant-scoped
 * repositories, so another office's group is never found. **A group grants nothing** (P3-T9 AC-1): this answers which
 * people a reader who already reads the whole office (`kpm_analytics:read`, ADR-0159 §2) wants the figures over, and
 * widens nobody's reach. Archived groups are not offered and not found (§4: *"An archived group is not offered"*).
 */
@Injectable()
export class OfficeGroups {
  constructor(
    private readonly groups: GroupRepository,
    private readonly members: MembershipRepository,
  ) {}

  /** The office's active groups A to Z, each with its members today. Two queries, whatever the number of groups. */
  async list(ctx: RequestContext): Promise<OfficeGroup[]> {
    const rows = await this.groups.find(ctx, { status: 'active' }, { sort: { name: 1 } });
    if (rows.length === 0) return [];
    const counts = await this.countsOf(ctx, rows.map((g) => String(g._id)));
    return rows.map((g) => ({ groupId: String(g._id), name: g.name, memberCount: counts.get(String(g._id)) ?? 0 }));
  }

  /**
   * **One group and its members today**, or `404 NOT_FOUND` — an unknown or malformed id, an archived group and
   * another office's are indistinguishable, as every 404 is.
   */
  async membersOf(ctx: RequestContext, groupId: string): Promise<{ group: OfficeGroup; memberIds: Set<string> }> {
    const row = await this.groups.findOne(ctx, { _id: groupId, status: 'active' });
    if (!row) throw new NotFoundException('Group');
    const tagged = await this.members.find(
      ctx, { groupIds: groupId, status: 'active' }, { projection: { _id: 1 } },
    );
    const memberIds = new Set(tagged.map((m) => String(m._id)));
    return { group: { groupId: String(row._id), name: row.name, memberCount: memberIds.size }, memberIds };
  }

  private async countsOf(ctx: RequestContext, groupIds: readonly string[]): Promise<Map<string, number>> {
    const tagged = await this.members.find(
      ctx, { groupIds: { $in: [...groupIds] }, status: 'active' }, { projection: { groupIds: 1 } },
    );
    const counts = new Map<string, number>();
    const offered = new Set(groupIds);
    for (const member of tagged) {
      for (const id of member.groupIds ?? []) if (offered.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }
}
