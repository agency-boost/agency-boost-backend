import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { HOME_QUOTE_POSES, type HomeQuotePose } from '@/domain/constants/home';
import type { CountOf, SplitFigure } from './home-figures';
import type { HomePerson, HomeTeamPerson, HomeView } from './home.service';

/** Declared for OpenAPI. The wire shapes live on `HomeService`'s view types. */

class HomeNowDto {
  @ApiProperty({ example: 545, description: 'The agency’s wall clock as the read was made, in minutes since midnight: the greeting’s time of day.' })
  minute!: number;
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
  @ApiProperty({ example: 3, description: 'Open *Tugas* today: action items and leads’ next actions due today, none ticked.' })
  tasks!: number;
}

class HomePersonDto implements HomePerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Wilson Tanoto' }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: '+6281211002200' }) phone!: string | null;
}

class HomeCoachingActionDto {
  @ApiProperty({ enum: ['coaching'] }) kind!: 'coaching';
  @ApiProperty() sessionId!: string;
  @ApiProperty() itemId!: string;
  @ApiProperty({ example: 'Siapkan daftar 20 prospek baru' }) text!: string;
  @ApiProperty({ type: HomePersonDto, nullable: true, description: '*Dari: NAME* — who coached them.' })
  from!: HomePersonDto | null;
}

class HomeLeadContactDto {
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
}

class HomeLeadActionDto {
  @ApiProperty({ enum: ['lead'] }) kind!: 'lead';
  @ApiProperty() leadId!: string;
  @ApiProperty({ example: 'Ibu Wiwik Setyaningsih' }) name!: string;
  @ApiProperty({ type: String, nullable: true, enum: ['sales', 'recruitment'] }) type!: 'sales' | 'recruitment' | null;
  @ApiProperty({ type: String, nullable: true, example: 'Invite BOP' }) note!: string | null;
  @ApiProperty({ type: HomeLeadContactDto }) contact!: HomeLeadContactDto;
  @ApiProperty({ example: 3, description: 'The lead’s version, for saving its number.' }) version!: number;
}

class HomeAgendaActionDto {
  @ApiProperty({ enum: ['agenda'] }) kind!: 'agenda';
  @ApiProperty({ enum: ['entry', 'event'] }) source!: 'entry' | 'event';
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'meeting', description: 'An entry’s type code, or a joined event’s type as the agency named it.' })
  type!: string;
  @ApiProperty({ example: 'Weekly unit huddle' }) title!: string;
  @ApiProperty({ example: '2026-10-30' }) date!: string;
  @ApiProperty({ example: '15:00' }) start!: string;
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

class HomeTeamPersonDto implements HomeTeamPerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Lukman Hakim' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to their photo, never the stored key.' })
  photoUrl!: string | null;
  @ApiProperty({ description: 'In the reader’s Unit; everybody is in the Group.' }) inUnit!: boolean;
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
        { $ref: getSchemaPath(HomeCoachingActionDto) },
        { $ref: getSchemaPath(HomeLeadActionDto) },
        { $ref: getSchemaPath(HomeAgendaActionDto) },
      ],
    },
    description: '*Aksi hari ini*: at most three — today’s tasks, then today’s timed things, then the next days’. An agenda '
      + 'row’s `id` is the Calendar’s own: an entry’s opens `GET /calendar/entries/{id}`, a joined event’s `/events/{id}`.',
  })
  actions!: HomeView['actions'];
  @ApiProperty({
    minimum: 0,
    example: 7,
    description: '*Leads* (`OWN_OPEN_LEADS`): your own open leads, Sales and Recruit — `OPEN_SALES_LEADS` and '
      + '`RECRUITMENT_PIPELINE_NOW` over you alone. Every reader’s.',
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
export const HOME_ACTION_DTOS = [HomeCoachingActionDto, HomeLeadActionDto, HomeAgendaActionDto] as const;
