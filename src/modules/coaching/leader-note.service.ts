import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  NoMembershipException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MemberNames } from '@/modules/org/member-names.service';
import type { SaveLeaderNoteDto } from './coaching-profile.dto';
import type { ProfilePerson } from './coaching-profile.service';
import { LeaderNoteRepository } from './leader-note.repository';
import type { LeaderNoteDocument } from './leader-note.schema';

/** The audit actions a note writes (`functional/coaching.md`, *A note read writes its own entry*). */
export const LEADER_NOTE_READ_ACTION = 'leader_note.read';
export const LEADER_NOTE_SAVED_ACTION = 'leader_note.saved';
/** Where a note was disclosed: the person shell's Leader Notes tab, the one read that answers notes. */
export const LEADER_NOTE_SURFACE = 'leader_notes';

/** The reader's own note about the coachee. */
export interface LeaderNoteMine {
  noteId: string;
  text: string;
  /** The version the next save pins. */
  version: number;
  updatedAt: string;
}

/** A note somebody below the reader wrote about the coachee, read-only (ADR-0073). */
export interface LeaderNoteOther {
  noteId: string;
  author: ProfilePerson;
  text: string;
  updatedAt: string;
}

/** `GET /coaching/coachees/:membershipId/leader-notes` (`functional/coaching.md`, the Data contract). */
export interface LeaderNotesView {
  mine: LeaderNoteMine | null;
  others: LeaderNoteOther[];
}

export interface LeaderNoteSaved {
  noteId: string;
  version: number;
  updatedAt: string;
}

/**
 * **Leader notes** (P11-T9 AC-4, AC-5, AC-6, AC-7, AC-9; ADR-0073, ADR-0090; `functional/coaching.md`,
 * *Who reads a leader note*).
 *
 * **Who reads a note**: its author, and the author's ancestors in the same office on the current leader
 * edges — `CoachResolver.readsLeaderNote`, per note — and nobody else. The rule follows the author, not
 * the coachee, so a leader who no longer coaches the person still reads what they wrote.
 *
 * **Never the coachee, tested before anything else is resolved**: the membership the route names, and
 * any other membership of the same person — somebody who left and rejoined the office is still the
 * person the old notes are about. A coachee who leads people is still the coachee.
 *
 * **Outside the set of readers the answer is 404**, as though no note existed: a refusal that names
 * notes tells a subject that notes about them exist. A current coach with nothing to read is answered
 * both empty; anybody else with nothing to read is not found. The guard refuses a support session
 * (`BLOCKED_WHILE_IMPERSONATING`), an Agent and an office role as such, 403, before this runs.
 *
 * **Every read by anyone but the author writes `leader_note.read`**, one per note disclosed, after the
 * answer exists, with `targetMembershipId` null so a view of the reads about a person can never list a
 * note. A save writes `leader_note.saved`, never the text. Both fail open (`AuditService.record`).
 */
@Injectable()
export class LeaderNoteService {
  constructor(
    private readonly notes: LeaderNoteRepository,
    private readonly coach: CoachResolver,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async read(ctx: RequestContext, membershipId: string): Promise<LeaderNotesView> {
    const me = requireMe(ctx);
    if (await this.isTheSubject(ctx, me, membershipId)) throw notFound();

    const about = await this.notes.find(ctx, { coacheeMembershipId: membershipId }, { sort: { updatedAt: -1 } });
    const readable: LeaderNoteDocument[] = [];
    for (const note of about) {
      if (await this.coach.readsLeaderNote(ctx, {
        authorMembershipId: note.authorMembershipId, subjectMembershipId: membershipId,
      })) readable.push(note);
    }
    if (readable.length === 0 && !(await this.coach.coaches(ctx, me, membershipId))) throw notFound();

    const own = readable.find((note) => note.authorMembershipId === me);
    const theirs = readable.filter((note) => note.authorMembershipId !== me);
    const authors = await this.names.byMembershipId(ctx, theirs.map((note) => note.authorMembershipId));

    const view: LeaderNotesView = {
      mine: own
        ? { noteId: String(own._id), text: own.text, version: own.version, updatedAt: own.updatedAt.toISOString() }
        : null,
      others: theirs.map((note) => ({
        noteId: String(note._id),
        author: { membershipId: note.authorMembershipId, name: authors.get(note.authorMembershipId) ?? '' },
        text: note.text,
        updatedAt: note.updatedAt.toISOString(),
      })),
    };

    // Written last, once the answer exists: a refused read writes nothing (ADR-0073, D-failopen).
    await Promise.all(theirs.map((note) => this.audit.record(ctx, {
      action: LEADER_NOTE_READ_ACTION,
      targetCollection: 'leaderNotes',
      targetId: String(note._id),
      targetMembershipId: null,
      after: {
        authorMembershipId: note.authorMembershipId,
        coacheeMembershipId: membershipId,
        surface: LEADER_NOTE_SURFACE,
      },
    })));
    return view;
  }

  /**
   * **The reader's own note about somebody they coach now**, whole, pinned to the version they read
   * (0 for a first note). The text it replaces is kept in `revisions[]`. Blank is a save. The text the
   * note already has is not: it is answered as it stands, with no version, revision or audit entry.
   */
  async save(ctx: RequestContext, membershipId: string, input: SaveLeaderNoteDto): Promise<LeaderNoteSaved> {
    const me = requireMe(ctx);
    if (!(await this.coach.coaches(ctx, me, membershipId))) throw notFound();

    const note = await this.notes.findOne(ctx, { coacheeMembershipId: membershipId, authorMembershipId: me });
    const current = note?.version ?? 0;
    if (input.version !== current) throw new VersionConflictException(input.version, current);
    /*
     * **The text it already has saves nothing.** A save of the stored text at the current version moves
     * no version, keeps no revision and writes no `leader_note.saved`: nothing was written, so there is
     * nothing to record. The note is answered as it stands, so the client pins the same version next.
     */
    if (note && note.text === input.text) return saved(note);

    const now = this.clock.now();
    const written = note
      ? await this.notes.updateIfAt(ctx, String(note._id), note.version, {
        $set: { text: input.text, updatedAt: now },
        $push: { revisions: { version: note.version, text: note.text, at: note.updatedAt } },
      })
      : await this.first(ctx, me, membershipId, input.text, now);
    if (!written) {
      const moved = await this.notes.findOne(ctx, { coacheeMembershipId: membershipId, authorMembershipId: me });
      throw new VersionConflictException(input.version, moved?.version ?? 0);
    }

    await this.audit.record(ctx, {
      action: LEADER_NOTE_SAVED_ACTION,
      targetCollection: 'leaderNotes',
      targetId: String(written._id),
      targetMembershipId: null,
      // Never the text: the office keeps who wrote a note about whom, and reads no note.
      after: { authorMembershipId: me, coacheeMembershipId: membershipId, version: written.version },
    });
    return saved(written);
  }

  // ------------------------------------------------------------------ internals

  /**
   * **Is the reader the person the notes are about?** The membership the route names, or another
   * membership of the same person in this office: one who left and rejoined has a new membership, and
   * the notes about the old one are still about them.
   */
  private async isTheSubject(ctx: RequestContext, me: string, membershipId: string): Promise<boolean> {
    if (membershipId === me) return true;
    const subject = await this.memberships.findById(ctx, membershipId);
    return subject !== null && String(subject.userId) === ctx.userId;
  }

  /** A first note: version 1. Two first saves at once write one note; the second is `VERSION_CONFLICT`. */
  private async first(
    ctx: RequestContext, authorMembershipId: string, coacheeMembershipId: string, text: string, now: Date,
  ): Promise<LeaderNoteDocument | null> {
    try {
      return await this.notes.create(ctx, {
        authorMembershipId, coacheeMembershipId, text, version: 1, revisions: [], createdAt: now, updatedAt: now,
      } as never);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }
}

/** What a save answers: the note's id, the version the next save pins, and when it last changed. */
function saved(note: LeaderNoteDocument): LeaderNoteSaved {
  return { noteId: String(note._id), version: note.version, updatedAt: note.updatedAt.toISOString() };
}

function requireMe(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}

/** Answered as though no note existed (ADR-0073): never a refusal that names notes. */
function notFound(): NotFoundException {
  return new NotFoundException('Membership');
}
