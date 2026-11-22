import { ApiProperty } from '@nestjs/swagger';
import { LEADER_MEETING_LIMITS } from '@/domain/constants';
import { ACTION_STATUSES, type ActionStatus } from './leader-meeting.schema';
import type {
  ActionItem, AgendaItem, ForumLimits, ForumPerson, MeetingCan, MeetingCard, MeetingListView, MeetingState, MeetingView,
  ShareLink,
} from './leader-meeting.view';

/** Declared for OpenAPI. The wire shapes live on `leader-meeting.view.ts`, as `frontend/src/lib/leader-meetings.ts` reads them. */

// ------------------------------------------------------------------ people and bounds

class ForumRungDto {
  @ApiProperty({ example: 'AB', description: 'The rung’s stable code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'AB', description: 'The ladder’s own label for it.' }) label!: string;
}

export class ForumPersonDto implements ForumPerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ example: 'Agus', description: 'The first word of the name: how a PIC is drawn.' }) firstName!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Their profile photo as a signed link; the avatar draws initials otherwise.' })
  photoUrl!: string | null;
  @ApiProperty({ type: ForumRungDto }) rung!: { code: string; label: string };
  @ApiProperty({ description: 'The reader themselves.' }) isReader!: boolean;
  @ApiProperty({ description: 'Tagged *Core leader* now: the header’s avatars and *"n core leader"*.' }) tagged!: boolean;
  @ApiProperty({ description: 'One of the forum’s editors now — the Owner, an Admin or a core leader — so offered as a PIC.' })
  pickable!: boolean;
}

export class ForumLimitsDto implements ForumLimits {
  @ApiProperty({ example: LEADER_MEETING_LIMITS.textMax, description: 'An agenda line, or an action item, after trimming.' })
  textMax!: number;
}

// ------------------------------------------------------------------ the list

export class ActionItemsDoneDto {
  @ApiProperty({ example: 3 }) done!: number;
  @ApiProperty({ example: 5 }) total!: number;
}

export class MeetingCardDto implements MeetingCard {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 15, description: '*Forum #15*.' }) number!: number;
  @ApiProperty({ example: '2026-11-27', description: 'An office date, `YYYY-MM-DD`.' }) date!: string;
  @ApiProperty({ type: String, nullable: true, example: '14:00', description: '`HH:MM`; `null` on a forum made before P19.22.' })
  time!: string | null;
  @ApiProperty({ enum: ['upcoming', 'completed'], description: '*Akan datang* through the end of its date, *Selesai* after.' })
  state!: MeetingState;
  @ApiProperty({ example: 8, description: 'Office days from today to its date: 0 *Hari ini*, 1 *Besok*, negative once past.' })
  daysUntil!: number;
  @ApiProperty({ example: 3, description: '*Agenda n item*.' }) agendaCount!: number;
  @ApiProperty({ type: ActionItemsDoneDto, description: '*Action items x/y selesai*.' }) actionProgress!: { done: number; total: number };
}

class CanCreateDto {
  @ApiProperty({ description: '*+ Forum baru*: false in a read-only support session.' }) create!: boolean;
}

export class MeetingListViewDto implements MeetingListView {
  @ApiProperty({ example: '2026-11-19', description: 'The office’s today.' }) today!: string;
  @ApiProperty({ type: [MeetingCardDto], description: 'Newest first: by date, then time, then number.' }) meetings!: MeetingCard[];
  @ApiProperty({ type: String, nullable: true, description: '*Forum berikutnya*: the nearest forum not yet held, or `null`.' })
  nextId!: string | null;
  @ApiProperty({ type: [ForumPersonDto], description: 'The office’s core leaders now: the navy card’s avatars.' })
  coreLeaders!: ForumPerson[];
  @ApiProperty({ type: CanCreateDto }) can!: { create: boolean };
  @ApiProperty({ type: ForumLimitsDto }) limits!: ForumLimits;
}

// ------------------------------------------------------------------ a forum

export class AgendaItemDto implements AgendaItem {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Rencana Closing Clinic Desember' }) text!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The PIC, a member in `people`; `null` with `picAll` (*Semua*) or none.' })
  picMembershipId!: string | null;
  @ApiProperty({ description: '*Semua*.' }) picAll!: boolean;
  @ApiProperty({ description: 'Ticked during the forum.' }) done!: boolean;
  @ApiProperty({ example: 1 }) version!: number;
}

export class AgendaItemRemovedDto {
  @ApiProperty({ enum: [true], description: 'The line’s text was emptied, so the line is gone.' }) removed!: true;
}

export class AgendaItemSavedDto {
  @ApiProperty({ required: false }) id?: string;
  @ApiProperty({ required: false }) text?: string;
  @ApiProperty({ required: false, type: String, nullable: true }) picMembershipId?: string | null;
  @ApiProperty({ required: false }) picAll?: boolean;
  @ApiProperty({ required: false }) done?: boolean;
  @ApiProperty({ required: false }) version?: number;
  @ApiProperty({ required: false, enum: [true], description: 'Present, and true, when the line was removed.' }) removed?: true;
}

export class LeaderActionItemDto implements ActionItem {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'Shared by the item and every copy carried from it.' }) lineageId!: string;
  @ApiProperty({ example: 'Siapkan Closing Clinic Desember' }) text!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The PIC, a member in `people`, or `null`.' }) picMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-12-02', description: '*Tenggat*, `YYYY-MM-DD`, or `null`.' })
  dueOn!: string | null;
  @ApiProperty({ enum: ACTION_STATUSES, description: '*Belum*, *Proses* or *Selesai*.' }) status!: ActionStatus;
  @ApiProperty({ type: Number, nullable: true, example: 13, description: '*dari forum #13* on a carried copy; `null` when raised here.' })
  fromNumber!: number | null;
  @ApiProperty({ example: 1 }) version!: number;
}

class MeetingCanDto implements MeetingCan {
  @ApiProperty({ description: 'Write the agenda and the action items: false by a link and in a read-only support session.' })
  edit!: boolean;
  @ApiProperty({ description: '*Bagikan*: make a read-only link for WhatsApp.' }) share!: boolean;
  @ApiProperty({ description: 'Move its date or time: only while it is upcoming.' }) reschedule!: boolean;
  @ApiProperty({ description: 'Delete it: only while nobody has written in it.' }) delete!: boolean;
  @ApiProperty({ description: '*PDF*: whoever reads it.' }) print!: boolean;
}

export class MeetingViewDto extends MeetingCardDto implements MeetingView {
  @ApiProperty({ example: 1, description: 'The head’s version: what a move sends.' }) version!: number;
  @ApiProperty({ type: [ForumPersonDto], description: 'The office’s core leaders now: *"n core leader · semua bisa mengedit"*.' })
  coreLeaders!: ForumPerson[];
  @ApiProperty({ type: [ForumPersonDto], description: 'Every person drawn: the editors (`pickable`), and any PIC who is no longer one.' })
  people!: ForumPerson[];
  @ApiProperty({ type: [AgendaItemDto], description: 'The checklist, in its order.' }) agenda!: AgendaItem[];
  @ApiProperty({ type: [LeaderActionItemDto], description: 'The action items, in their order.' }) actionItems!: ActionItem[];
  @ApiProperty({ description: 'Somebody has written in it: it can no longer be deleted.' }) writtenIn!: boolean;
  @ApiProperty({ enum: ['address', 'link'], description: 'Read by its address, or by a shared link.' }) via!: 'address' | 'link';
  @ApiProperty({ type: MeetingCanDto }) can!: MeetingCan;
  @ApiProperty({ type: ForumLimitsDto }) limits!: ForumLimits;
}

export class ShareLinkDto implements ShareLink {
  @ApiProperty({ description: 'The raw token: in this answer and nowhere else.' }) token!: string;
  @ApiProperty({ example: '2026-12-03T03:00:00.000Z' }) expiresAt!: string;
}
