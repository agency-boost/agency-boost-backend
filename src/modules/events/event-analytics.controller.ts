import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { EventAnalyticsQueryDto, EventFeedbackDto, KehadiranDto } from './event-analytics.dto';
import { EventAnalytics } from './event-analytics.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const READ_400 = refusal(400, '`VALIDATION_FAILED` — a `month` that is no month or is later than this one, or a parameter of any other name.');
const READ_403 = refusal(
  403,
  '`TENANT_NO_MEMBERSHIP` — a Super Admin who has not entered a KPM (`X-Kpm-Id`). `PERM_DENIED` — a role without the '
  + 'permission: an Agent.',
);
const READ_404 = refusal(
  404,
  '`NOT_FOUND` — an AB or an AAB who is not a core leader. Indistinguishable from another office’s.',
);

/**
 * **Advanced analytics › *Event*** (ADR-0281; `functional/advanced-analytics.md`, *Event*): *Kehadiran* and *Feedback*,
 * the KPM's stewards' (the Super Admin inside the KPM, the Owner, an Admin, a core leader). On the page's prefix beside
 * `AdvancedAnalyticsController`, as `SurveyRunsController` is; the events module's own reading.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/advanced-analytics/events')
export class EventAnalyticsController {
  constructor(private readonly analytics: EventAnalytics) {}

  @Get('attendance')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Event › Kehadiran* — who came, by event, group and person; who means to come',
    description: 'The period’s past events — each hadir of its audience as at its start, from the roll call; one whose '
      + 'roll call has not been taken is in no average — the informal groups’ attendance over the period, the last 15 '
      + 'recorded events and each event, every member’s marks, and the events not yet ended with the answers to their '
      + 'invitation (*Akan ikut*, *Tidak ikut* with the reason, *Belum jawab*). Test accounts are never counted.',
  })
  @ApiResponse({ status: 200, type: KehadiranDto })
  @ApiResponse(READ_400)
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  attendance(@Ctx() ctx: RequestContext, @Query() query: EventAnalyticsQueryDto) {
    return this.analytics.attendance(ctx, query);
  }

  @Get('feedback')
  @RequirePermission('advanced_analytics:read')
  @ApiOperation({
    summary: '*Event › Feedback* — what those who came thought',
    description: 'The NPS over every answer of a member who was hadir in the period, its average, its count and the '
      + 'share of those hadir who answered; then each past event, lowest NPS first, with its answers’ words tagged '
      + '*Leader* or *Agent*. No survey is sent and no respondent is named.',
  })
  @ApiResponse({ status: 200, type: EventFeedbackDto })
  @ApiResponse(READ_400)
  @ApiResponse(READ_403)
  @ApiResponse(READ_404)
  feedback(@Ctx() ctx: RequestContext, @Query() query: EventAnalyticsQueryDto) {
    return this.analytics.feedbackView(ctx, query);
  }
}
