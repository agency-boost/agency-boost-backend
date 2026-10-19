import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SaveActivationChecklistDto } from './activation.dto';
import { ActivationService } from './activation.service';

/**
 * An office's 90-day activation checklist (P5-T3).
 *
 * **Draft, then publish** — the checklist is one versioned document, not rows, because a hire's
 * activation pins the version it was created against. It does not ride the office's snapshot, so
 * *Publish to agents* elsewhere in Settings says nothing about it, and this publish says nothing
 * about the rest.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/activation-checklist')
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  /*
   * **The Owner's and the Admins' read** (`activation_settings:read`; the Phase 18.5 exit review, B2): it answers the
   * draft and names each training link by the module's working title, a draft's included. It sat on
   * `tenant_config:read`, which every member holds. A field member reads their own activation, named from what the
   * office offers.
   */
  @Get()
  @RequirePermission('activation_settings:read')
  @ApiOperation({
    summary: 'The office\'s activation checklist',
    description:
      'The published version hires starting now are given, the working draft if there is one, and '
      + 'the office\'s activation window. Each item carries its link, resolved: what it waits for, '
      + 'where that sends a reader, and whether an evaluator exists yet.',
  })
  async read(@Ctx() ctx: RequestContext) {
    return this.activation.read(ctx);
  }

  @Put()
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Save the working draft',
    description:
      'The whole checklist, not a patch: order is the order of the lists sent. Refuses a duplicate '
      + 'code, a link this product does not have, and a training link to a module the office does '
      + 'not offer — naming every problem at once. Nothing reaches a hire until it is published.',
  })
  async saveDraft(@Ctx() ctx: RequestContext, @Body() body: SaveActivationChecklistDto) {
    return this.activation.saveDraft(ctx, body);
  }

  @Post('publish')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Publish the draft as the next version',
    description:
      'Turns the draft into the next version, which is then immutable and given to hires who start '
      + 'after it. Hires already under way keep the version they started on. Refuses when there is '
      + 'no draft, and re-checks the training links, which can be archived between saving and publishing.',
  })
  async publish(@Ctx() ctx: RequestContext) {
    return this.activation.publish(ctx);
  }
}
