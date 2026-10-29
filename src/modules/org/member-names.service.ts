import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { User, UserDocument } from '@/modules/users/user.schema';
import { MembershipRepository } from './membership.repository';
import type { MembershipDocument } from './membership.schema';

/** A membership as `MembershipRepository` answered it, with the two fields naming it reads. */
export type ReadMembership = Pick<MembershipDocument, '_id' | 'userId'>;

/**
 * A person as a sentence about them names them: the name, and the pronoun the copy is written in.
 * The pronoun is the user's own (`users.pronoun`, `they` unless they said otherwise), never guessed
 * from the name.
 */
export interface NamedPerson {
  name: string;
  pronoun: 'she' | 'he' | 'they';
}

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
    const people = await this.people(ctx, membershipIds);
    return new Map([...people].map(([membershipId, person]) => [membershipId, person.name]));
  }

  /**
   * `membershipId → { name, pronoun }`, by the same two reads and the same rules as `byMembershipId`
   * — which is this, with the pronoun dropped (P11-T7). Coaching writes about the person it opens in
   * their own pronoun (*Leads that need her*), so it needs both, and asks once.
   */
  async people(
    ctx: RequestContext, membershipIds: readonly string[],
  ): Promise<Map<string, NamedPerson>> {
    /*
     * **A malformed id is nobody, not a server fault.** `$in` over a list holding one throws a
     * `CastError`, which is neither a `DomainException` nor an `HttpException` and renders as a
     * 500 — for a caller who passed an id from somewhere older or hand-written. The tenant
     * repository has taken this position on `findById` since Phase 2; this is the same position,
     * and a fixture using readable ids is what found it missing.
     */
    const unique = [...new Set(membershipIds)].filter((id) => Boolean(id) && isValidObjectId(id));
    if (unique.length === 0) return new Map();

    const members = await this.memberships.find(ctx, { _id: { $in: unique } });
    return this.peopleOf(members);
  }

  /**
   * **`byMembershipId`, for memberships the caller has just read through the tenant repository** (the Owner's
   * reporting at 500 members, 2026-10-29): their `_id` and `userId`, as `MembershipRepository` answered them, so they
   * are not read a second time — the users read alone. `OfficePeople` reads every member's row for its figures; asking
   * `byMembershipId` beside it read all of them again, whole, for the one field — 16.7 ms of the names' 19.
   *
   * The same rules, from the same code: a membership whose person has no name on file is absent. **Rows from a
   * scoped read, never ids a caller put together**: the first hop is still the tenant repository's, so the user read
   * that follows reaches only people the office holds a membership for.
   */
  async byReadMemberships(members: readonly ReadMembership[]): Promise<Map<string, string>> {
    const people = await this.peopleOf(members);
    return new Map([...people].map(([membershipId, person]) => [membershipId, person.name]));
  }

  /** The second hop: the users behind memberships already read, each once, over their primary key. */
  private async peopleOf(members: readonly ReadMembership[]): Promise<Map<string, NamedPerson>> {
    const userIds = [...new Set(members.map((m) => String(m.userId)))];
    if (userIds.length === 0) return new Map();

    const users = await this.users.find({ _id: { $in: userIds } }).select('fullName pronoun').lean().exec();
    const named = new Map(
      (users as unknown as { _id: unknown; fullName?: string; pronoun?: NamedPerson['pronoun'] }[])
        // A row older than the field reads as the schema's default, which `lean()` does not apply.
        .map((u) => [String(u._id), { name: u.fullName ?? '', pronoun: u.pronoun ?? 'they' }]),
    );

    const out = new Map<string, NamedPerson>();
    for (const member of members) {
      const person = named.get(String(member.userId));
      if (person?.name) out.set(String(member._id), person);
    }
    return out;
  }
}
