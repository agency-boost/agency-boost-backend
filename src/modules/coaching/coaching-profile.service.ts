import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  CapabilityService, type CapabilityEntryView, type CapabilityGridView, type CapabilityStageView,
} from '@/modules/capability/capability.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import type { SaveCoachingProfileDto } from './coaching-profile.dto';
import { CoachingProfileRepository } from './coaching-profile.repository';
import type { CoachingProfileDocument } from './coaching-profile.schema';

/** A member, by the membership that identifies them. `name` is empty when it can no longer be named. */
export interface ProfilePerson {
  membershipId: string;
  name: string;
}

/**
 * **The office's capability catalog, archived rows included, each with its status** (P11-T9 AC-3). An
 * item the office has since archived still renders on a profile that ticked it, and takes no new tick.
 */
export interface ProfileCatalogView {
  stages: CapabilityStageView[];
  milestones: CapabilityEntryView[];
  grids: CapabilityGridView[];
}

/** `GET /coaching/coachees/:membershipId/profile` (`functional/coaching.md`, the Data contract). */
export interface CoachingProfileView {
  catalog: ProfileCatalogView;
  milestoneCodes: string[];
  skillCodes: string[];
  /** The highest stage whose required milestones are all ticked; `null` below the first. Never stored. */
  stageCode: string | null;
  /** 0 before the first save: the version the first save pins. */
  version: number;
  updatedAt: string | null;
  updatedBy: ProfilePerson | null;
}

/** What a profile save answers: the version the next save pins, and the stage the ticks now give. */
export interface CoachingProfileSaved {
  version: number;
  stageCode: string | null;
  updatedAt: string;
}

/**
 * **The capability ladder and the skill tracker of one coachee** (P11-T9 AC-1, AC-2, AC-3, AC-7;
 * `functional/coaching.md`, *Who reads the profile* and *Leader Notes*).
 *
 * **One profile per coachee, read and ticked by every current coach of that person**: `COACH(reader,
 * subject)` and nothing wider. Anybody else is 404 — the coachee themselves first of all, a leader who
 * leads people included, since `COACH` never reaches oneself; a former coach; a peer; another office.
 * The Owner, the Admin and the Super Admin hold no `coaching_profile:*` grant as such.
 *
 * **The catalog comes with the profile**, read through `CapabilityService.read` — the office's whole
 * catalog, archived rows with their status, or the company's defaults for an office never given one —
 * and not through the config snapshot (AC-3).
 *
 * **No audit entry.** Only those who write the profile read it, and a save is attributed in the record
 * itself: `updatedBy`, and the tick set it replaced in `revisions[]` (`functional/coaching.md`, *Writes*).
 */
@Injectable()
export class CoachingProfileService {
  constructor(
    private readonly profiles: CoachingProfileRepository,
    private readonly coach: CoachResolver,
    private readonly capability: CapabilityService,
    private readonly names: MemberNames,
    private readonly clock: Clock,
  ) {}

  async read(ctx: RequestContext, membershipId: string): Promise<CoachingProfileView> {
    await this.requireCoachee(ctx, membershipId);

    const [catalog, profile] = await Promise.all([
      this.capability.read(ctx),
      this.profiles.findOne(ctx, { coacheeMembershipId: membershipId }),
    ]);
    const milestoneCodes = profile ? [...profile.milestoneCodes] : [];
    const [stage, updatedBy] = await Promise.all([
      this.capability.stageFor(ctx, milestoneCodes),
      profile?.updatedBy ? this.person(ctx, profile.updatedBy) : Promise.resolve(null),
    ]);

    return {
      catalog: { stages: catalog.stages, milestones: catalog.milestones, grids: catalog.grids },
      milestoneCodes,
      skillCodes: profile ? [...profile.skillCodes] : [],
      stageCode: stage?.code ?? null,
      version: profile?.version ?? 0,
      updatedAt: profile ? profile.updatedAt.toISOString() : null,
      updatedBy,
    };
  }

  /**
   * **The whole tick set, pinned to the version it was read at** (AC-1, AC-2, AC-7).
   *
   * Refused, in this order: 404 outside `COACH`; 400 `VALIDATION_FAILED` for a code the catalog does
   * not hold, archived rows included, in `details.unknown`; 409 `VERSION_CONFLICT` when another coach
   * saved since; 422 `CONFIG_ARCHIVED` for an item the office archived that this save ticks **anew**,
   * in `details.codes`. An archived item the profile already held may stay ticked, or be unticked.
   * An item of an archived grid is archived with it.
   */
  async save(
    ctx: RequestContext, membershipId: string, input: SaveCoachingProfileDto,
  ): Promise<CoachingProfileSaved> {
    await this.requireCoachee(ctx, membershipId);
    const milestoneCodes = [...new Set(input.milestoneCodes)];
    const skillCodes = [...new Set(input.skillCodes)];

    const [catalog, profile] = await Promise.all([
      this.capability.read(ctx),
      this.profiles.findOne(ctx, { coacheeMembershipId: membershipId }),
    ]);
    const milestones = new Map(catalog.milestones.map((m) => [m.code, m.status]));
    const items = new Map(catalog.grids.flatMap((grid) => grid.items.map((item) => [
      item.code, grid.status === 'archived' ? 'archived' : item.status,
    ] as const)));

    const unknown = {
      milestoneCodes: milestoneCodes.filter((code) => !milestones.has(code)),
      skillCodes: skillCodes.filter((code) => !items.has(code)),
    };
    if (unknown.milestoneCodes.length + unknown.skillCodes.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        // ADR-0084 rule 2: a string coaching writes itself uses none of the six words.
        'Every tick must name a milestone or a skill item in the capability catalog.',
        HttpStatus.BAD_REQUEST,
        { unknown },
      );
    }

    const current = profile?.version ?? 0;
    if (input.version !== current) throw new VersionConflictException(input.version, current);

    const held = new Set([...(profile?.milestoneCodes ?? []), ...(profile?.skillCodes ?? [])]);
    const archivedAnew = [
      ...milestoneCodes.filter((code) => milestones.get(code) === 'archived'),
      ...skillCodes.filter((code) => items.get(code) === 'archived'),
    ].filter((code) => !held.has(code));
    if (archivedAnew.length > 0) {
      // Invariant §3: archived configuration stays readable so history renders, not writable.
      throw new DomainException(
        ErrorCode.CONFIG_ARCHIVED,
        // Shown in the Leader Notes tab's banner as written (ADR-0084 rule 2; parity L-66).
        'This item has been retired. A profile that already had it keeps it; nobody ticks it anew.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { codes: archivedAnew },
      );
    }

    const now = this.clock.now();
    const saved = profile
      ? await this.profiles.updateIfAt(ctx, String(profile._id), profile.version, {
        $set: { milestoneCodes, skillCodes, updatedAt: now },
        $push: { revisions: replacedTickSet(profile) },
      })
      : await this.first(ctx, membershipId, milestoneCodes, skillCodes, now);
    if (!saved) throw await this.conflict(ctx, membershipId, input.version);

    const stage = await this.capability.stageFor(ctx, saved.milestoneCodes);
    return { version: saved.version, stageCode: stage?.code ?? null, updatedAt: saved.updatedAt.toISOString() };
  }

  // ------------------------------------------------------------------ internals

  /** `COACH(reader, subject)`, or the 404 every coaching read outside it answers. */
  private async requireCoachee(ctx: RequestContext, membershipId: string): Promise<void> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();
    if (!(await this.coach.coaches(ctx, me, membershipId))) throw new NotFoundException('Membership');
  }

  /**
   * The first save: version 1. **Two coaches saving a first tick set at once write one profile**: the
   * unique index refuses the second insert, and the caller answers it `VERSION_CONFLICT`.
   */
  private async first(
    ctx: RequestContext, coacheeMembershipId: string, milestoneCodes: string[], skillCodes: string[], now: Date,
  ): Promise<CoachingProfileDocument | null> {
    try {
      return await this.profiles.create(ctx, {
        coacheeMembershipId, milestoneCodes, skillCodes, version: 1, revisions: [], createdAt: now, updatedAt: now,
      } as never);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  /** Why a pinned save matched nothing: somebody else saved the profile first. */
  private async conflict(ctx: RequestContext, membershipId: string, version: number): Promise<VersionConflictException> {
    const now = await this.profiles.findOne(ctx, { coacheeMembershipId: membershipId });
    return new VersionConflictException(version, now?.version ?? 0);
  }

  private async person(ctx: RequestContext, membershipId: string): Promise<ProfilePerson> {
    const named = await this.names.byMembershipId(ctx, [membershipId]);
    return { membershipId, name: named.get(membershipId) ?? '' };
  }
}

/** The tick set a save replaces, kept whole with when and by whom it was written (`erd.md`). */
function replacedTickSet(profile: CoachingProfileDocument) {
  return {
    version: profile.version,
    milestoneCodes: [...profile.milestoneCodes],
    skillCodes: [...profile.skillCodes],
    at: profile.updatedAt,
    // Every writer of a profile stamps it: the first save's `create`, and every pinned save.
    byMembershipId: profile.updatedBy as string,
  };
}
