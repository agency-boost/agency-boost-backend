import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { AnnouncementAudienceDto, SendAnnouncementDto } from './announcements.dto';
import { AnnouncementDto, AnnouncementPreviewDto } from './announcements.response.dto';
import { AnnouncementsService } from './announcements.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** ***Pengumuman*** (P19.23-T6 AC-4; ADR-0279): `/admin/platform/announcements`. The Super Admin's alone. */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/platform/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequirePermission('announcement:read')
  @ApiOperation({ summary: 'The announcements sent, newest first', description: 'At most 20: what, to whom, how many, who and when.' })
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse({ status: 200, type: AnnouncementDto, isArray: true })
  async list(@Ctx() ctx: RequestContext) {
    return this.announcements.list(ctx);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('announcement:send')
  @ApiOperation({
    summary: 'How many people an announcement would reach',
    description: '*Pratinjau* and *Kirim ke n owner*: each person once, test accounts never counted. Writes nothing.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — an audience it does not know, an id that is not one, or `selected` '
    + 'with nothing chosen (`details.field`).'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse({ status: 200, type: AnnouncementPreviewDto })
  async preview(@Ctx() ctx: RequestContext, @Body() dto: AnnouncementAudienceDto) {
    return this.announcements.preview(ctx, dto);
  }

  @Post()
  @RequirePermission('announcement:send')
  @ApiOperation({
    summary: 'Send an announcement',
    description:
      '*Kirim*: to every Owner, every member, or the members of the companies and KPMs chosen — each person once, in the '
      + 'app (`platform.announcement`), test accounts not sent to. Recorded and audited as `announcement.sent`. Answers '
      + 'the sent announcement.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `message` empty or past 500 characters, or the audience as above.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse(refusal(409, '`ANNOUNCEMENT_NO_RECIPIENTS` — the audience reaches nobody. Nothing is sent.'))
  @ApiResponse({ status: 201, type: AnnouncementDto })
  async send(@Ctx() ctx: RequestContext, @Body() dto: SendAnnouncementDto) {
    return this.announcements.send(ctx, dto);
  }
}
