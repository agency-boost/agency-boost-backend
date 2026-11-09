import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { User, type UserDocument } from '@/modules/users/user.schema';

/**
 * **Members' WhatsApp numbers, for the Overview's reminders** (P19.3-T2 AC-2; UI-148's Appendix D row, *"member phone
 * numbers per UI-101"*; the owner's D-22): `membershipId → users.phone`, for the few rows a list shows.
 *
 * **Scoped for the memberships, by id for the users** — `MemberNames`' rule: the memberships are read through the
 * tenant repository, so a number is read only for somebody the office holds a membership for; the user behind each is
 * global (invariant §2) and read by `_id` from that list. Two reads, whatever the office's size. A member with no number
 * on file is absent.
 */
@Injectable()
export class OfficePhones {
  constructor(
    private readonly memberships: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async of(ctx: RequestContext, membershipIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.memberships.find(ctx, { _id: { $in: ids } }, { projection: { userId: 1 } });
    const userIds = rows.map((row) => row.userId).filter((id) => isValidObjectId(id));
    const users = userIds.length === 0
      ? []
      : await this.users.find({ _id: { $in: userIds } }).select('phone').lean().exec();
    const phoneOf = new Map(users.map((u) => [String(u._id), (u as { phone?: string | null }).phone ?? null]));
    const out = new Map<string, string>();
    for (const row of rows) {
      const phone = phoneOf.get(String(row.userId));
      if (phone) out.set(String(row._id), phone);
    }
    return out;
  }
}
