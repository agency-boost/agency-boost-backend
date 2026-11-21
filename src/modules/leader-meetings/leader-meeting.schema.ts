import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeaderMeetingDocument = HydratedDocument<LeaderMeeting>;

/**
 * *Belum* → *Proses* → *Selesai* (P19.22-T8 AC-4; ADR-0276): an action item's three states, the order the status menu
 * lists them. Until migration `0076` they were *Not yet planned* · *Planned* · *Implemented* (`not_planned`,
 * `planned`, `implemented`), mapped one to one.
 */
export const ACTION_STATUSES = ['todo', 'doing', 'done'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** An editor as the freeze wrote them before P19.22 (D-coeditors): kept on old meetings, read by nothing. */
export type EditorStanding = 'owner' | 'admin' | 'core_leader';

/** Who the forum's people are: the Owner, an Admin, or a member tagged *Core leader*. */
export interface ForumEditor {
  membershipId: string;
  as: EditorStanding;
  rungCode: string;
  /** Tagged *Core leader* now — what *"n core leader"* counts. */
  tagged: boolean;
}

/**
 * **One line of the agenda's checklist** (P19.22-T8 AC-3; ADR-0276): its text, its PIC — a member of the office, by
 * membership id (invariant §2), or *Semua* (`picAll`), or none — and its box, ticked during the meeting. Versioned on
 * its own, so two leaders writing two lines both land.
 */
@Schema({ _id: false })
export class LeaderMeetingAgendaItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  /** Plain text, stored as typed and served as text, never as markup (F-187). */
  @Prop({ type: String, default: '' })
  text!: string;

  /** The PIC's membership `_id`, or `null` (none, or *Semua*). Never a name. */
  @Prop({ type: String, default: null })
  picMembershipId!: string | null;

  /** *Semua*: everybody at the forum. `picMembershipId` is then `null`. */
  @Prop({ type: Boolean, default: false })
  picAll!: boolean;

  @Prop({ type: Boolean, default: false })
  done!: boolean;

  @Prop({ type: Number, default: 1 })
  version!: number;
}

export const LeaderMeetingAgendaItemSchema = SchemaFactory.createForClass(LeaderMeetingAgendaItem);

/**
 * **One action item** (P19.22-T8 AC-4; ADR-0276): what is to be done, its PIC (a member, by membership id), its
 * *tenggat* (an office date), its state, its place, and its own version.
 *
 * **Carried over by copy** (ADR-0276): an item not *Selesai* when the next forum is made is copied into it — a new
 * `itemId`, **the same `lineageId`** — with `fromNumber` the number of the forum its lineage began in (*dari forum #n*).
 * A write to one copy is passed to the copies of the same lineage in **later** forums only, and a delete removes them
 * there too, never in an earlier forum.
 */
@Schema({ _id: false })
export class LeaderMeetingActionItem {
  @Prop({ type: String, required: true })
  itemId!: string;

  /** Shared by an item and every copy carried from it: the id the forward sync and the delete follow. */
  @Prop({ type: String, required: true })
  lineageId!: string;

  @Prop({ type: String, default: '' })
  text!: string;

  /** The PIC's membership `_id`, or `null` for none. Never a name (invariant §2). */
  @Prop({ type: String, default: null })
  picMembershipId!: string | null;

  /** *Tenggat*: an office date, `YYYY-MM-DD`, or `null` for none. */
  @Prop({ type: String, default: null })
  dueOn!: string | null;

  @Prop({ type: String, enum: ACTION_STATUSES, default: 'todo' })
  status!: ActionStatus;

  /** The number of the forum the lineage began in, on a carried copy; `null` on an item raised in this forum. */
  @Prop({ type: Number, default: null })
  fromNumber!: number | null;

  /** The item's place: the items are served by it. */
  @Prop({ type: Number, required: true })
  order!: number;

  @Prop({ type: Number, default: 1 })
  version!: number;
}

export const LeaderMeetingActionItemSchema = SchemaFactory.createForClass(LeaderMeetingActionItem);

/**
 * **A forum of the office's core leaders** — *Forum #n*, every two weeks (P19.22-T8; ADR-0276, amending ADR-0129 to
 * ADR-0132; `functional/leader-forum.md`, *The record*).
 *
 * The office's, `kpmId` leading every index, read and written only through `LeaderMeetingRepository`, and
 * soft-deleted. **Saved field by field**: each agenda line and action item carries its own `version`, and the head's
 * `version` covers its date and time alone, so two leaders writing different lines both land. *Akan datang* and
 * *Selesai* are derived from `date` in the office's calendar, never stored.
 *
 * **Left on a meeting made before P19.22 and read by nothing** (ADR-0276): its `monthlyTargets`, the scorecard and the
 * editors written at its freeze (`frozenScorecard`, `frozenAt`, `frozenCoeditors`), and the minutes as they were before
 * migration `0076` (`legacyMinutes`). The schema does not name them, so no write touches them.
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

  /** Kept from before P19.22, when a meeting had a title; `''` on a forum made since. The screens say *Forum #n*. */
  @Prop({ type: String, default: '' })
  title!: string;

  /** `YYYY-MM-DD`, an office date in `kpms.timezone` — never an instant. */
  @Prop({ type: String, required: true })
  date!: string;

  /** `HH:MM`, office time (P19.22-T8 AC-1); `null` on a meeting made before it, drawn with its date alone. */
  @Prop({ type: String, default: null })
  time!: string | null;

  @Prop({ type: [LeaderMeetingAgendaItemSchema], default: [] })
  agendaItems!: LeaderMeetingAgendaItem[];

  @Prop({ type: [LeaderMeetingActionItemSchema], default: [] })
  actionItems!: LeaderMeetingActionItem[];

  /**
   * The first write in the agenda or the action items after the forum was made — **what "nobody has written in"
   * means** (ADR-0130 §5). A move, a share or a carried copy arriving from an earlier forum is not writing.
   */
  @Prop({ type: Date, default: null })
  writtenAt!: Date | null;

  /** The head's version: a move of the date or the time bumps it, nothing else does. */
  @Prop({ type: Number, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership ids, never a user id or a name (invariant §2); `null` for the Super Admin inside the KPM. */
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
/** A lineage's copies in later forums: the forward sync and the delete (ADR-0276). */
LeaderMeetingSchema.index({ kpmId: 1, 'actionItems.lineageId': 1 });
