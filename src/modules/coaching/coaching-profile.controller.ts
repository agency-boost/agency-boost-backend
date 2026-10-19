import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { SaveCoachingProfileDto, SaveLeaderNoteDto } from './coaching-profile.dto';
import {
  CoachingProfileDto, CoachingProfileSavedDto, LeaderNoteSavedDto, LeaderNotesDto,
} from './coaching-profile.response.dto';
import { CoachingProfileService } from './coaching-profile.service';
import { LeaderNoteService } from './leader-note.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **The Leader Notes tab** (`functional/coaching.md`, *Leader Notes* and the Data contract): the
 * capability ladder and the skill tracker of somebody you coach, and the private notes about them.
 *
 * Its own controller beside `CoachingController`, under the same `coaching` prefix. Every path here
 * has four segments, so none shadows, or is shadowed by, a route there.
 */
@ApiTags('coaching')
@ApiBearerAuth()
@Controller('coaching')
export class CoachingProfileController {
  constructor(
    private readonly profiles: CoachingProfileService,
    private readonly notes: LeaderNoteService,
  ) {}

  @Get('coachees/:membershipId/profile')
  @RequirePermission('coaching_profile:read')
  @ApiOperation({
    summary: 'Somebody’s capability ladder and skill tracker',
    description:
      '*Capability mapping* and *Skill tracker*: the milestones and skill items ticked for somebody you '
      + 'coach, the stage those milestones give, and the office’s whole capability catalog to draw them '
      + 'against — archived items included, with their status, so an item the office retired still shows '
      + 'on a profile that ticked it. One profile per person, shared by everybody who coaches them now. '
      + 'Anybody else, the person themselves included, is not found. Not recorded: only their coaches '
      + 'read it.',
  })
  @ApiResponse({ status: 200, type: CoachingProfileDto })
  async profile(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.profiles.read(ctx, membershipId);
  }

  @Put('coachees/:membershipId/profile')
  @RequirePermission('coaching_profile:update')
  @ApiOperation({
    summary: 'Save somebody’s capability ladder and skill tracker',
    description:
      'The whole tick set, pinned to the version you read: every milestone and skill item ticked, by the '
      + 'catalog’s code. A code not sent is unticked. The tick set it replaces is kept. Anybody who coaches '
      + 'the person now may save it.',
  })
  @ApiResponse({ status: 200, type: CoachingProfileSavedDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a field is missing or malformed, or a code is not in the office’s catalog '
    + '(`details.unknown.milestoneCodes`, `details.unknown.skillCodes`).',
  ))
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — another coach saved it since you read it. Read it again.'))
  @ApiResponse(refusal(
    422,
    '`CONFIG_ARCHIVED` — the office retired an item this save ticks for the first time (`details.codes`). '
    + 'A profile that already had it keeps it.',
  ))
  async saveProfile(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: SaveCoachingProfileDto,
  ) {
    return this.profiles.save(ctx, membershipId, body);
  }

  @Get('coachees/:membershipId/leader-notes')
  @RequirePermission('leader_notes:read')
  @ApiOperation({
    summary: 'The private notes about somebody',
    description:
      '*Personal notes*: your own note about the person, and the notes leaders below you wrote about them, '
      + 'read-only. A note is read by the leader who wrote it and by the leaders above that leader, and by '
      + 'nobody else: **never the person it is about**, never the Owner or the Admin as such, and never in '
      + 'a support session. Somebody you coach with no note yet answers both empty; anybody else with '
      + 'nothing to read is not found. Every note somebody else wrote that you read is recorded.',
  })
  @ApiResponse({ status: 200, type: LeaderNotesDto })
  async leaderNotes(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.notes.read(ctx, membershipId);
  }

  @Put('coachees/:membershipId/leader-notes')
  @RequirePermission('leader_notes:write')
  @ApiOperation({
    summary: 'Save your private note about somebody',
    description:
      '*Save notes*: your own note about somebody you coach now, whole, pinned to the version you read — 0 '
      + 'for your first. Blank is allowed, and the text it replaces is kept. At most 4,000 characters. Only '
      + 'you write your note; the save is recorded, never its text. Saving the text it already has '
      + 'changes nothing and records nothing: it answers the note as it stands. Refused in a support session.',
  })
  @ApiResponse({ status: 200, type: LeaderNoteSavedDto })
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — you saved this note somewhere else since you read it. Read it again.'))
  async saveLeaderNote(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() body: SaveLeaderNoteDto,
  ) {
    return this.notes.save(ctx, membershipId, body);
  }
}
