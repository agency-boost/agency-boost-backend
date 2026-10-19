import { Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CampaignAgentService } from './campaign-agent.service';
import { CampaignCardDto, CampaignDetailDto, CampaignListDto, ChasingDto } from './campaign-agent.response.dto';

/** No parameter: the pipe refuses any by name rather than ignoring it. */
export class CampaignListQueryDto {}

/** **`for`, and nothing else**: whose chases. */
export class CampaignChasingQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description: 'The **membership** whose chases to read. Omitted, or your own, it is yours; anybody else as far as '
      + 'your coaching reaches, or the whole agency for its owner and its administrators.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;
}

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **The agent's campaigns** (P18.5-T7, T8, T9; `functional/campaigns.md`, the Data contract): the list, one
 * campaign with the reader's progress, the chase, and whose chases a reader may see.
 *
 * **The literal path before the parameter**: `chasing` is declared ahead of `:code`, so the chases read is never
 * taken for a campaign — and `CHASING` is refused as a campaign's code (`campaign-input.ts`).
 */
@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignAgentController {
  constructor(private readonly campaigns: CampaignAgentService) {}

  @Get()
  @RequirePermission('campaign:read_list')
  @ApiOperation({
    summary: 'The campaigns you may chase',
    description:
      'Every active campaign of your agency, archived ones never: seasonal and structural, each with its phase '
      + 'derived now, its window in words, its poster, its requirements with the registry’s names, whether you are '
      + 'chasing it, and whether — and why not — you may. In the order the page draws them.',
  })
  @ApiResponse({ status: 200, type: CampaignListDto })
  async list(@Ctx() ctx: RequestContext, @Query() _query: CampaignListQueryDto) {
    return this.campaigns.list(ctx);
  }

  @Get('chasing')
  @RequirePermission('campaign_qualification:read')
  @ApiOperation({
    summary: 'The campaigns somebody is chasing',
    description:
      'Yours, or with `for` somebody your coaching reaches — campaigns not ended, in the order the page draws them. '
      + 'The Personal Summary’s card and a coachee’s chips read this one answer. Nothing is recorded.',
  })
  @ApiResponse({ status: 200, type: ChasingDto })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names somebody you may not read, somebody in another agency, or a member of another office: '
    + 'deliberately indistinguishable, since a `403` would confirm the id exists.',
  ))
  async chasing(@Ctx() ctx: RequestContext, @Query() query: CampaignChasingQueryDto) {
    return this.campaigns.chasing(ctx, query.for);
  }

  @Get(':code')
  @RequirePermission('campaign:read_list')
  @ApiOperation({
    summary: 'One campaign, and how far you are',
    description:
      'The card’s fields, its description, and — once it has begun — your progress in each requirement row: the '
      + 'figure over its window from the agency’s production file or your log, its target, and whether it is met, '
      + 'still open, *Not uploaded yet* (a month not held is never a miss) or *Not measured yet*.',
  })
  @ApiResponse({ status: 200, type: CampaignDetailDto })
  async detail(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.campaigns.detail(ctx, code);
  }

  @Put(':code/chase')
  @RequirePermission('campaign:chase')
  @ApiOperation({
    summary: 'Chase a campaign',
    description: 'Mark it as one you are chasing. Again changes nothing. An upcoming campaign may be chased; an ended one not.',
  })
  @ApiResponse({ status: 200, type: CampaignCardDto })
  @ApiResponse(refusal(409, '`CAMPAIGN_NOT_OPEN` — the campaign has ended. Nothing is written.'))
  @ApiResponse(refusal(403, '`CAMPAIGN_NOT_ELIGIBLE` — it is not open to your role. Nothing is written.'))
  async chase(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.campaigns.chase(ctx, code);
  }

  @Delete(':code/chase')
  @RequirePermission('campaign:chase')
  @ApiOperation({
    summary: 'Stop chasing a campaign',
    description: 'Take it off your list. Again changes nothing. Refused once the campaign has ended: the list it was on is closed.',
  })
  @ApiResponse({ status: 200, type: CampaignCardDto })
  @ApiResponse(refusal(409, '`CAMPAIGN_NOT_OPEN` — the campaign has ended. Nothing is written.'))
  async unchase(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.campaigns.unchase(ctx, code);
  }
}
