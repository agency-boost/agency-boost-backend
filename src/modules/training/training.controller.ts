import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { TrainingService } from './training.service';

/**
 * An office's training taxonomy, as the settings screens read it (P5-T1).
 *
 * **Read only.** Every write goes through the staged batch, `POST /kpm/settings/changes`,
 * like the rest of an office's configuration — validated whole before anything is written, and
 * published to agents as one snapshot. What agents are offered is `GET /kpm/config`.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/training')
export class TrainingController {
  constructor(private readonly training: TrainingService) {}

  @Get()
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The office\'s training taxonomy',
    description:
      'Categories, each with its skills, each with its modules, in display order. **Drafts '
      + 'are included**: this is the office\'s configuration, not what agents are offered, '
      + 'which is `GET /kpm/config`. `includeArchived=true` is the settings screen\'s, so an '
      + 'Owner can bring a row back.',
  })
  async list(@Ctx() ctx: RequestContext, @Query('includeArchived') includeArchived?: string) {
    return this.training.list(ctx, includeArchived === 'true');
  }
}
