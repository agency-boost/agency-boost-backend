import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeaderMeetingDocument = HydratedDocument<LeaderMeeting>;

/** *Preparation* · *During* · *Post* (`KPM_Owner.html:2802-2820`), in the order drawn. */
export const AGENDA_SECTIONS = ['preparation', 'during', 'post'] as const;
export type AgendaSection = (typeof AGENDA_SECTIONS)[number];

/** *Not yet planned* → *Planned* → *Implemented* (`:2865`), the order the status button cycles. */
export const ACTION_STATUSES = ['not_planned', 'planned', 'implemented'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** How an editor stood when the meeting was frozen: the Owner, an Admin, or a member tagged *Core Leader*. */
export type EditorStanding = 'owner' | 'admin' | 'core_leader';

/**
 * **One agenda item** (`:2802-2820`): its text and a PIC typed by hand — a name, never a membership — and, on
 * *During* alone, whether it is ticked. Versioned on its own, so two leaders writing two items both land.
 */
@Schema({ _id: false })
export class LeaderMeetingAgendaItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  /** Plain text, stored as typed and served as text, never as markup (F-187). */
  @Prop({ type: String, default: '' })
  text!: string;

  /** Free text; `''` is none, drawn *—*. */
  @Prop({ type: String, default: '' })
  pic!: string;

  /** Meaningful on *During* only, where the prototype draws the boxes (`:2817`). */
  @Prop({ type: Boolean, default: false })
  done!: boolean;

  @Prop({ type: Number, default: 1 })
  version!: number;
}

export const LeaderMeetingAgendaItemSchema = SchemaFactory.createForClass(LeaderMeetingAgendaItem);

/** The agenda's three sections, each a list of items in the order written. */
@Schema({ _id: false })
export class LeaderMeetingAgenda {
  @Prop({ type: [LeaderMeetingAgendaItemSchema], default: [] })
  preparation!: LeaderMeetingAgendaItem[];

  @Prop({ type: [LeaderMeetingAgendaItemSchema], default: [] })
  during!: LeaderMeetingAgendaItem[];

  @Prop({ type: [LeaderMeetingAgendaItemSchema], default: [] })
  post!: LeaderMeetingAgendaItem[];
}

export const LeaderMeetingAgendaSchema = SchemaFactory.createForClass(LeaderMeetingAgenda);

/**
 * **One row of the *Action items tracker*** (`:2822-2843`): the six named columns — *Key initiative*, *Success
 * metric*, *Action item*, *PIC*, *Status*, *Remarks / Target* — its place among the rows, and its own version.
 */
@Schema({ _id: false })
export class LeaderMeetingActionItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  @Prop({ type: String, default: '' })
  initiative!: string;

  @Prop({ type: String, default: '' })
  metric!: string;

  @Prop({ type: String, default: '' })
  action!: string;

  /** Free text, typed by hand (`:2834`). */
  @Prop({ type: String, default: '' })
  pic!: string;

  @Prop({ type: String, enum: ACTION_STATUSES, default: 'not_planned' })
  status!: ActionStatus;

  /** The *Remarks / Target* column (`:2692`, `:2831`, `:2839`). */
  @Prop({ type: String, default: '' })
  remarks!: string;

  /** The row's place: the rows are served by it, and a reorder writes it and nothing else. */
  @Prop({ type: Number, required: true })
  order!: number;

  @Prop({ type: Number, default: 1 })
  version!: number;
}

export const LeaderMeetingActionItemSchema = SchemaFactory.createForClass(LeaderMeetingActionItem);

/** A *Monthly Target* cell (`:2462-2471`): short text, *TBD* a value, versioned on its own. */
export interface MonthlyTargetCell {
  value: string;
  version: number;
}

/** An editor as the freeze wrote them (D-coeditors): ids and how they stood, never a name (invariant §2). */
export interface FrozenEditor {
  membershipId: string;
  as: EditorStanding;
  rungCode: string;
  /** Tagged *Core Leader* at the freeze: what *"{n} core leaders tagged"* counts, the Owner aside. */
  tagged: boolean;
}

/**
 * **A meeting of the office's leaders** — a numbered *Strategic Check-in* (D-forum-model, ADR-0129 to ADR-0132;
 * `functional/leader-forum.md`, *The record*).
 *
 * The office's, `kpmId` leading every index, read and written only through `LeaderMeetingRepository`, and
 * soft-deleted. **Saved field by field**: each agenda item, action item and *Monthly Target* cell carries its own
 * `version`, and the head's `version` covers the title and the date alone, so two leaders writing different rows
 * both land. *Upcoming* and *Completed* are derived from `date` in the office's calendar, never stored.
 *
 * **Not stored, ever**: an attendee list, a notes field, a per-meeting list of co-editors and a lock (`lockedAt`,
 * struck by ADR-0132) — the tag is the list, and the minutes stay editable.
 */
@Schema({ ...configSchemaOptions, collection: 'leaderMeetings' })
export class LeaderMeeting {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /**
   * One past the highest number among the office's meetings not deleted, given when it is made (ADR-0130 §2), so
   * a deleted meeting's number may be given again. Never changed.
   */
  @Prop({ type: Number, required: true, min: 1 })
  number!: number;

  /** Plain text, trimmed, 1 to `LEADER_MEETING_LIMITS.titleMax` characters. */
  @Prop({ type: String, required: true })
  title!: string;

  /** `YYYY-MM-DD`, an office date in `kpms.timezone` — never an instant. */
  @Prop({ type: String, required: true })
  date!: string;

  @Prop({ type: LeaderMeetingAgendaSchema, default: () => ({ preparation: [], during: [], post: [] }) })
  agenda!: LeaderMeetingAgenda;

  @Prop({ type: [LeaderMeetingActionItemSchema], default: [] })
  actionItems!: LeaderMeetingActionItem[];

  /**
   * The *Monthly Target* cells typed, keyed by the scorecard's row (the six the prototype leaves unblocked). A row
   * never typed is absent, and served `{ value: '', version: 0 }`. Never frozen: it is typed, and stays editable.
   */
  @Prop({ type: Object, default: () => ({}) })
  monthlyTargets!: Partial<Record<string, MonthlyTargetCell>>;

  /**
   * The first write in the agenda, the tracker or a target after the meeting was made — **what "nobody has
   * written in" means** (ADR-0130 §5). A move or a share is not writing.
   */
  @Prop({ type: Date, default: null })
  writtenAt!: Date | null;

  /** The scorecard as computed at the freeze (ADR-0129 §7), without the typed targets; `null` while live. */
  @Prop({ type: Object, default: null })
  frozenScorecard!: Record<string, unknown> | null;

  /** The first read once *Completed* writes it, in one write that lands only where none has. */
  @Prop({ type: Date, default: null })
  frozenAt!: Date | null;

  /** Each editor at the freeze (D-coeditors): the meeting's record of who could edit it then. Grants nothing. */
  @Prop({ type: Object, default: null })
  frozenCoeditors!: FrozenEditor[] | null;

  /** The head's version: a move of the title or the date bumps it, nothing else does. */
  @Prop({ type: Number, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, never a user id or a name (invariant §2). */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const LeaderMeetingSchema = SchemaFactory.createForClass(LeaderMeeting);

/** The list, newest first by date. */
LeaderMeetingSchema.index({ kpmId: 1, date: -1 });
/**
 * The next number, and one number per live meeting: two meetings made at once cannot both take #15 — the second
 * is refused by the index and numbered again. A deleted meeting leaves it, so its number may be given again.
 */
LeaderMeetingSchema.index({ kpmId: 1, number: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
