import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { HOME_QUOTE_POSES, type HomeQuotePose } from '@/domain/constants/home';
import type { CalendarTaskView, JoinedEvent } from '@/modules/calendar/calendar-auto-items';
import { CalendarEntryDto, CalendarJoinedEventDto, CalendarTaskDto } from '@/modules/calendar/calendar.response.dto';
import type { CalendarEntryView } from '@/modules/calendar/calendar-view';
import type { CountOf, SplitFigure } from './home-figures';
import type { HomeTeamPerson, HomeView } from './home.service';

/** Declared for OpenAPI. The wire shapes live on `HomeService`'s view types. */

class HomeNowDto {
  @ApiProperty({ example: 545, description: 'The agency’s wall clock as the read was made, in minutes since midnight: the greeting’s time of day.' })
  minute!: number;
  @ApiProperty({
    example: '2026-10-30T02:05:00.000Z',
    description: 'The instant the read was made (UTC). The page counts on from it to the agency’s midnight and reads Home again, so *Aksi hari ini* turns with the day.',
  })
  at!: string;
}

class HomeQuoteDto {
  @ApiProperty({ example: 16, description: 'The quote’s place in the list, from 0: the agency’s day number mod 20.' })
  index!: number;
  @ApiProperty({ example: 'Plans are only good intentions unless they immediately degenerate into hard work.', description: 'In the language it was said in, whatever the reader’s.' })
  text!: string;
  @ApiProperty({ example: 'Peter Drucker' }) person!: string;
  @ApiProperty({ enum: HOME_QUOTE_POSES, description: 'Boost’s pose: the day number mod 4.' }) pose!: HomeQuotePose;
}

class HomeDayDto {
  @ApiProperty({ example: '2026-10-30' }) date!: string;
  @ApiProperty({ example: 4, description: 'The day’s saved total; 0 where nothing was saved.' }) count!: number;
}

class HomeActivityDto {
  @ApiProperty({ example: 0 }) today!: number;
  @ApiProperty({ example: 5 }) yesterday!: number;
  @ApiProperty({ type: [HomeDayDto], description: 'The seven agency days ending today, oldest first.' }) days!: HomeDayDto[];
  @ApiProperty({ example: 18 }) total!: number;
}

class HomeScheduleDto {
  @ApiProperty({ example: 2, description: 'Timed things today: calendar entries not declined (no trip) and joined events.' })
  meetings!: number;
  @ApiProperty({ example: 3, description: 'Open *Tugas* today: action items and leads’ next actions due today; a ticked one is not counted.' })
  tasks!: number;
}

/** *Aksi hari ini*'s task row (P19.11-T1): the Calendar's own *Tugas*, as the Agenda's checklist reads it. */
class HomeTaskActionDto {
  @ApiProperty({ enum: ['task'] }) kind!: 'task';
  @ApiProperty({
    type: CalendarTaskDto,
    description: 'A lead’s next action or a coaching action item due today, `done` when ticked — its checkbox ticks it '
      + '(`PUT /leads/{id}/next-action/done`, `PUT /coaching/sessions/{sessionId}/action-items/{itemId}/done`).',
  })
  task!: CalendarTaskView;
}

/** *Aksi hari ini*'s entry row (P19.11-T1): a calendar entry of today's, as `GET /calendar/entries` answers it. */
class HomeEntryActionDto {
  @ApiProperty({ enum: ['entry'] }) kind!: 'entry';
  @ApiProperty({ type: CalendarEntryDto, description: 'Its `entryId` opens `GET /calendar/entries/{entryId}`, the detail Home opens over itself.' })
  entry!: CalendarEntryView;
}

/** *Aksi hari ini*'s event row (P19.11-T1): an event the reader joined, as the Calendar answers it. */
class HomeEventActionDto {
  @ApiProperty({ enum: ['event'] }) kind!: 'event';
  @ApiProperty({ type: CalendarJoinedEventDto, description: 'Its `eventId` opens `/events/{eventId}`.' })
  event!: JoinedEvent;
}

class HomeCountOfDto implements CountOf {
  @ApiProperty({ example: 1 }) count!: number;
  @ApiProperty({ example: 4 }) of!: number;
}

class HomeSplitDto implements SplitFigure {
  @ApiProperty({ example: 4 }) count!: number;
  @ApiProperty({ example: 12, description: 'Manpower: everybody in the Group, its head and the new hires included.' }) of!: number;
  @ApiProperty({ type: HomeCountOfDto, description: 'The head and their direct agents.' }) unit!: HomeCountOfDto;
  @ApiProperty({ type: HomeCountOfDto, description: 'Every AAB unit below them.' }) aab!: HomeCountOfDto;
}

/** A person's rung on *Laporan aktivitas tim*'s *Group* tab (P19.9-T2 AC-2; ADR-0235). */
class HomeRungDto {
  @ApiProperty({ example: 'AAB', description: 'The rung’s code on the company’s ladder.' }) code!: string;
  @ApiProperty({ example: 'AAB', description: 'The company’s own label for it; the code where the ladder has none.' })
  label!: string;
}

class HomeTeamPersonDto implements HomeTeamPerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Lukman Hakim' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to their photo, never the stored key.' })
  photoUrl!: string | null;
  @ApiProperty({ description: 'In the reader’s Unit; everybody is in the Group.' }) inUnit!: boolean;
  @ApiProperty({
    type: HomeRungDto,
    description: 'Their rung, which the *Group* tab names in the company’s short words — *AB*, *AAB*, *Agent* (ADR-0235).',
  })
  rung!: HomeRungDto;
  @ApiProperty({ type: Number, nullable: true, description: 'Yesterday’s saved total; `null` for no saved day.' })
  yesterday!: number | null;
  @ApiProperty({ type: Number, nullable: true }) today!: number | null;
}

class HomeLeaderDto {
  @ApiProperty({ type: HomeSplitDto, description: 'Exactly the Unit Dashboard’s *Active Agent* tile.' }) activeAgent!: HomeSplitDto;
  @ApiProperty({ type: HomeSplitDto, description: 'Members coached in the last 7 days (`COACHED_7D`), out of manpower.' })
  coached7d!: HomeSplitDto;
  @ApiProperty({
    type: [HomeTeamPersonDto],
    description: '*Laporan aktivitas tim*: everybody in your Group but you — nobody-reported first, then not today, then the rest.',
  })
  team!: HomeTeamPersonDto[];
}

export class HomeDto implements HomeView {
  @ApiProperty({ example: '2026-10-30' }) today!: string;
  @ApiProperty({ example: '2026-10-29' }) yesterday!: string;
  @ApiProperty({ example: '2026-10' }) month!: string;
  @ApiProperty({ type: HomeNowDto }) now!: HomeNowDto;
  @ApiProperty({ type: HomeQuoteDto }) quote!: HomeQuoteDto;
  @ApiProperty({ type: HomeActivityDto }) activity!: HomeActivityDto;
  @ApiProperty({ type: HomeScheduleDto }) schedule!: HomeScheduleDto;
  @ApiProperty({
    type: 'array',
    maxItems: 3,
    items: {
      oneOf: [
        { $ref: getSchemaPath(HomeTaskActionDto) },
        { $ref: getSchemaPath(HomeEntryActionDto) },
        { $ref: getSchemaPath(HomeEventActionDto) },
      ],
    },
    description: '*Aksi hari ini*: **today’s alone** (the agency’s day), at most three — today’s tasks first, open and '
      + 'ticked, in the Calendar’s checklist order; then today’s timed things not yet ended, soonest first, one that '
      + 'began on an earlier day included. Nothing of another day. Each in the Calendar’s own shape.',
  })
  actions!: HomeView['actions'];
  @ApiProperty({
    minimum: 0,
    example: 7,
    description: '*Leads* (`OWN_OPEN_LEADS`): every open lead you own, any type and any stage — what `/leads` opens on '
      + '(`GET /leads?scope=own&outcome=open`’s `total`). Every reader’s.',
  })
  leads!: number;
  @ApiProperty({
    minimum: 0,
    example: 1,
    description: '*New hires*: your Group’s new hires before a first sale (ADR-0172 §1), the Unit Dashboard’s count; 0 when '
      + 'you lead nobody.',
  })
  newHires!: number;
  @ApiProperty({
    type: HomeLeaderDto,
    nullable: true,
    description: 'Every leader by role — an AB, an AAB, an Owner or an Admin — at zero with no team yet (ADR-0189 §4); '
      + '`null` for an Agent who leads nobody.',
  })
  leader!: HomeLeaderDto | null;
}

/** The union's members, for `ApiExtraModels` (the controller registers them). */
export const HOME_ACTION_DTOS = [HomeTaskActionDto, HomeEntryActionDto, HomeEventActionDto] as const;
