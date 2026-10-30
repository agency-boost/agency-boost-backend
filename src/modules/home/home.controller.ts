import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { HOME_ACTION_DTOS, HomeDto } from './home.response.dto';
import { HomeService, type HomeView } from './home.service';

/**
 * **Home** (UI V1, 2026-10-30, Phase 18.99 T11; UI-100, UI-101; `functional/home.md`): `GET /home`, every block of the
 * page every field member lands on, in one read. Takes nothing: it is the reader's own.
 */
@ApiTags('home')
@ApiExtraModels(...HOME_ACTION_DTOS)
@ApiBearerAuth()
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get()
  @RequirePermission('personal_summary:read')
  @ApiOperation({
    summary: 'Your Home: today, your list, your last seven days — and your team’s, if you lead',
    description:
      'Every block of Home in one read, for the reader alone. **Your own**: your activity today and yesterday and the '
      + 'seven days ending today (the totals Activity Management saved, on the agency’s calendar); today’s timed '
      + 'calendar items and today’s open tasks (your latest 1:1’s action items due today, and your own leads whose '
      + 'next action is today); *Aksi hari ini*, at most three — today’s tasks, then your next timed items; and the '
      + 'quote and the pose of the day. **If you lead somebody**: *Active Agent* exactly as the Unit Dashboard’s tile '
      + 'counts it, *Coaching 7 hari* (members coached in the last 7 days, out of the same manpower), each with its '
      + '*Unit* and *AAB* split, and *Laporan tim* — everybody in your Group but you, yesterday’s and today’s count, '
      + 'nobody-reported first, with their photo (a signed link) and WhatsApp number; each of them recorded as read. '
      + 'Somebody who leads nobody gets `leader: null`.',
  })
  @ApiResponse({ status: 200, type: HomeDto })
  @ApiResponse({
    status: 403,
    description: '`PERM_DENIED` — the caller holds no `personal_summary:read`; `NO_MEMBERSHIP` — they belong to no office.',
    type: ApiErrorEnvelope,
  })
  async read(@Ctx() ctx: RequestContext): Promise<HomeView> {
    return this.home.read(ctx);
  }
}
