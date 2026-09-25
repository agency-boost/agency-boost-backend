import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { User, UserDocument } from '@/modules/users/user.schema';
import { MembershipRepository } from './membership.repository';

/**
 * A person's name, from the **membership** that identifies them.
 *
 * Invariant §2: the membership `_id` is the foreign key on every per-user document, and `users` is
 * the global collection holding the name. So *"who edited this?"* is two hops, and every screen
 * that attributes a change needs both — which is why this is one service rather than the same
 * two-collection dance copied into each of them.
 *
 * **Batched, never one per row.** A page of fifty leads edited by four people costs two reads, not
 * a hundred: the ids are collected first and each collection asked once, over its primary key.
 *
 * **Scoped for the memberships, unscoped for the users.** A membership belongs to an office and is
 * read through the tenant repository; the user behind it is global and is read by `_id` from a list
 * the scoped read produced — so nothing here can reach a person the caller's office does not
 * already hold a membership for.
 */
@Injectable()
export class MemberNames {
  constructor(
    private readonly memberships: MembershipRepository,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /**
   * `membershipId → full name`, for the ids this office actually holds.
   *
   * An id that resolves to nothing is **absent from the map** rather than present with a
   * placeholder: the caller then decides what a missing name means on its own surface, and a
   * screen cannot accidentally render the word "Unknown" as though it were somebody.
   */
  async byMembershipId(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(membershipIds)].filter(Boolean);
    if (unique.length === 0) return new Map();

    const members = await this.memberships.find(ctx, { _id: { $in: unique } });
    const userIds = [...new Set(members.map((m) => String(m.userId)))];
    if (userIds.length === 0) return new Map();

    const people = await this.users.find({ _id: { $in: userIds } }).select('fullName').lean().exec();
    const named = new Map(
      (people as unknown as { _id: unknown; fullName?: string }[])
        .map((u) => [String(u._id), u.fullName ?? '']),
    );

    const out = new Map<string, string>();
    for (const member of members) {
      const name = named.get(String(member.userId));
      if (name) out.set(String(member._id), name);
    }
    return out;
  }
}
