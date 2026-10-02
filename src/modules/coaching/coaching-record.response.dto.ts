import { ApiProperty } from '@nestjs/swagger';
import { SessionHistoryRowDto, SessionPersonDto } from './coaching-session.response.dto';
import type { SessionHistoryRow, SessionPerson } from './coaching-session.service';
import type { LedSessionRow, MySessionsView, PrintPeriod, SessionPrintView } from './coaching-record.service';

/** Declared for OpenAPI. The wire shapes live on the service's view types. */

// ------------------------------------------------------------------ the print

export class PrintPersonDto {
  @ApiProperty({ example: 'Indah Permatasari', description: 'Empty when the membership can no longer be named.' })
  name!: string;
}

export class PrintLastWeekItemDto {
  @ApiProperty({ example: 'Book two presentations' }) text!: string;

  @ApiProperty({ description: 'Ticked done by this session: printed `[x]`, else `[ ]`.' }) done!: boolean;
}

export class PrintPeriodDto implements PrintPeriod {
  @ApiProperty({ type: Number, nullable: true, description: 'IDR sen; `null` for somebody with no goal.' })
  targetMinor!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'IDR sen; `null` when nothing was held yet — never a 0 in its place.' })
  actualMinor!: number | null;
}

export class PrintGoalDto {
  @ApiProperty({ example: 'IDR' }) currency!: string;

  @ApiProperty({ type: PrintPeriodDto, description: '*This month*, as the 1:1 saw it.' }) monthly!: PrintPeriod;

  @ApiProperty({ type: PrintPeriodDto, description: '*This year*, as the 1:1 saw it.' }) yearly!: PrintPeriod;
}

export class PrintTipDto {
  @ApiProperty({ example: 'Confirm the next meeting before you leave the current one.' }) text!: string;
}

export class PrintLeadActionDto {
  @ApiProperty({ example: '2026-10-03', description: 'The lead’s next action date, as the session took it.' })
  dueDate!: string;

  @ApiProperty({ example: 'Collect the signed SPAJ.', description: 'The lead’s note, or *Follow up with {name}*.' })
  text!: string;

  @ApiProperty({ example: 'Pak Hendro Gunawan', description: 'Printed *(Leads: {name})*.' }) leadName!: string;
}

export class PrintActionItemDto {
  @ApiProperty({ type: String, nullable: true, example: '2026-10-07' }) dueDate!: string | null;

  @ApiProperty({ example: 'Shadow Sari on one presentation' }) text!: string;
}

export class SessionPrintDto implements SessionPrintView {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ example: 3, description: 'The finalized version printed: the latest, so a session being corrected prints the version the correction will replace.' })
  version!: number;

  @ApiProperty({ example: '2026-09-28', description: 'The day the session was held — its first finalize, in your agency’s calendar — never today’s.' })
  date!: string;

  @ApiProperty({ type: PrintPersonDto, description: 'Who it is about.' }) coachee!: { name: string };

  @ApiProperty({ type: PrintPersonDto, description: 'Who led it.' }) coach!: { name: string };

  @ApiProperty({ type: PrintLastWeekItemDto, isArray: true, description: '*Last week’s action items*, with their ticks.' })
  lastWeekItems!: { text: string; done: boolean }[];

  @ApiProperty({
    type: PrintGoalDto, nullable: true,
    description: 'The goal the 1:1 looked at, frozen when it was first finalized. `null` for a session that holds no snapshot.',
  })
  goal!: SessionPrintView['goal'];

  @ApiProperty({ type: PrintTipDto, isArray: true, description: '*Coaching tips*.' }) tips!: { text: string }[];

  @ApiProperty({ type: PrintLeadActionDto, isArray: true, description: '*Next action items — from leads*.' })
  leadActions!: SessionPrintView['leadActions'];

  @ApiProperty({ type: PrintActionItemDto, isArray: true, description: '*Next action items — other*.' })
  actionItems!: SessionPrintView['actionItems'];
}

// ------------------------------------------------------------------ /coaching/me

export class LedSessionRowDto implements LedSessionRow {
  @ApiProperty() sessionId!: string;

  @ApiProperty({ example: '2026-09-28' }) date!: string;

  @ApiProperty({ type: SessionPersonDto, description: 'Who it was about: somebody you no longer coach.' })
  coachee!: SessionPerson;

  @ApiProperty({ example: 3, description: 'Its action items, from leads and typed.' }) actionItemCount!: number;

  @ApiProperty({ example: 1, description: 'How many of them the next session you led with them ticked done.' })
  completedCount!: number;
}

export class MySessionsDto implements MySessionsView {
  @ApiProperty({
    type: SessionHistoryRowDto, isArray: true,
    description: 'Your own coaching: the finalized sessions about you, newest first, each with who led it. Not paginated.',
  })
  sessions!: SessionHistoryRow[];

  @ApiProperty({
    type: LedSessionRowDto, isArray: true,
    description:
      'The finalized sessions you led with somebody you no longer coach, newest first: yours to read, never to '
      + 'change. Empty for somebody who has led nobody. Not paginated.',
  })
  ledFormerly!: LedSessionRow[];
}
