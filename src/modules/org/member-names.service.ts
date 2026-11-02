import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { AvatarLinks } from '@/modules/users/avatar.service';
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
 * A person as a row that draws their avatar names them (UI V1, UI-111): `NamedPerson`, and their profile photo as a
 * signed link — `null` for none, which the row draws as initials.
 */
export interface PicturedPerson extends NamedPerson {
  photoUrl: string | null;
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
    /*
     * **Each photo as a signed link** (UI V1, UI-111): `users.avatarUrl` holds a storage key and the bucket is private
     * (ADR-0153), so `pictured` signs the photos it answers (`AvatarLinks`, once per photo per half day). The
     * application always provides it; optional, so the many readers built with the two above keep naming people, and
     * without it every photo is `null` — initials, never a key.
     */
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
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
   * **`people`, with the photos of the people a read draws an avatar for** (UI V1, UI-111: *every avatar of yours —
   * Unit roster, coaching lists, Leader Forum — shows it*): the same two reads, the photo's key read beside the name,
   * then **one batch of signatures** (`AvatarLinks.linksFor`) over the photos of `drawnIds` alone — the rows the read
   * returns with an avatar, never a coach or a corrector it only names. Everybody else, and anybody without a photo,
   * has `photoUrl: null`. A photo that cannot be signed is `null` too: the read still answers.
   */
  async pictured(
    ctx: RequestContext, membershipIds: readonly string[], drawnIds: readonly string[] = membershipIds,
  ): Promise<Map<string, PicturedPerson>> {
    const unique = [...new Set(membershipIds)].filter((id) => Boolean(id) && isValidObjectId(id));
    if (unique.length === 0) return new Map();

    const members = await this.memberships.find(ctx, { _id: { $in: unique } });
    const people = await this.peopleOf(members, true);
    const drawn = new Set(drawnIds);
    const links = this.avatarLinks
      ? await this.avatarLinks.linksFor([...people].filter(([id]) => drawn.has(id)).map(([, p]) => p.photoKey))
      : new Map<string, string>();

    const out = new Map<string, PicturedPerson>();
    for (const [id, { photoKey, ...person }] of people) {
      out.set(id, { ...person, photoUrl: drawn.has(id) && photoKey ? links.get(photoKey) ?? null : null });
    }
    return out;
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

  /**
   * The second hop: the users behind memberships already read, each once, over their primary key — with `photos`,
   * each one's photo key (`users.avatarUrl`) beside the name, for `pictured` to sign.
   */
  private async peopleOf(members: readonly ReadMembership[]): Promise<Map<string, NamedPerson>>;
  private async peopleOf(
    members: readonly ReadMembership[], photos: true,
  ): Promise<Map<string, NamedPerson & { photoKey: string | null }>>;
  private async peopleOf(
    members: readonly ReadMembership[], photos = false,
  ): Promise<Map<string, NamedPerson & { photoKey?: string | null }>> {
    const userIds = [...new Set(members.map((m) => String(m.userId)))];
    if (userIds.length === 0) return new Map();

    const users = await this.users.find({ _id: { $in: userIds } })
      .select(photos ? 'fullName pronoun avatarUrl' : 'fullName pronoun').lean().exec();
    const named = new Map(
      (users as unknown as { _id: unknown; fullName?: string; pronoun?: NamedPerson['pronoun']; avatarUrl?: string | null }[])
        // A row older than the field reads as the schema's default, which `lean()` does not apply.
        .map((u) => [String(u._id), {
          name: u.fullName ?? '',
          pronoun: u.pronoun ?? 'they',
          ...(photos ? { photoKey: u.avatarUrl ?? null } : {}),
        }]),
    );

    const out = new Map<string, NamedPerson & { photoKey?: string | null }>();
    for (const member of members) {
      const person = named.get(String(member.userId));
      if (person?.name) out.set(String(member._id), person);
    }
    return out;
  }
}
