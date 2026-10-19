import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeaderNoteDocument = HydratedDocument<LeaderNote>;

/**
 * **A text a save replaced**, kept whole (`erd.md`, *`leaderNotes`*): the version it was and when it was
 * written. Every one is the author's, so the entry needs no second name. No screen lists it.
 */
@Schema({ _id: false })
export class LeaderNoteRevision {
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, default: '' })
  text!: string;

  /** When that text was saved. */
  @Prop({ type: Date, required: true })
  at!: Date;
}

export const LeaderNoteRevisionSchema = SchemaFactory.createForClass(LeaderNoteRevision);

/**
 * **A leader's private note about one coachee** (P11-T9; ADR-0073; `erd.md`, *`leaderNotes`*).
 *
 * One per author and coachee. Written only by its author while they coach the coachee; read by its
 * author and by the author's ancestors in the same office on the current leader edges; **never by its
 * coachee**, nor by the Owner, the Admin or the Super Admin as such. Clearing the text is a save, not a
 * delete, and no route deletes a note.
 *
 * **Joined into no other answer.** No session, snapshot, print, notification or roster row carries a
 * field of this record (`functional/coaching.md`, *No leader note reaches its subject*).
 *
 * Personal data under UU 27/2022, about the coachee and holding the author's judgement of them. P19-T1's
 * erasure cascade reaches it.
 */
@Schema({ ...configSchemaOptions, collection: 'leaderNotes' })
export class LeaderNote {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** Who wrote it, by membership — the note's owner, for `leader_notes:read`'s scope tokens. */
  @Prop({ type: String, required: true })
  authorMembershipId!: string;

  /** Who it is about, by membership. Never one of its readers. */
  @Prop({ type: String, required: true })
  coacheeMembershipId!: string;

  /** Blank is allowed: clearing a note is a save. At most `NOTE_LIMITS.TEXT_MAX` characters. */
  @Prop({ type: String, default: '' })
  text!: string;

  /** Counts saves: the first is 1, and a note never saved reads as 0. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: [LeaderNoteRevisionSchema], default: [] })
  revisions!: LeaderNoteRevision[];

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const LeaderNoteSchema = SchemaFactory.createForClass(LeaderNote);

/**
 * **One note per author and coachee**, and the walk the Leader Notes read makes: every note about a
 * coachee, then the reader's own. Partial on `deletedAt: null`; `kpmId` leads (invariant §1).
 */
LeaderNoteSchema.index(
  { kpmId: 1, coacheeMembershipId: 1, authorMembershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
