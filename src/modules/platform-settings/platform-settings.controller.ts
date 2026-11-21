import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { UpdatePlatformSettingsDto } from './platform-settings.dto';
import { PlatformSettingsDto } from './platform-settings.response.dto';
import { PlatformSettingsService } from './platform-settings.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** ***Pengaturan platform*** (P19.23-T6 AC-3; ADR-0279): `/admin/platform/settings`. The Super Admin's alone. */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/platform/settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @RequirePermission('platform_settings:read')
  @ApiOperation({
    summary: 'The platform’s settings',
    description:
      'The WhatsApp number AgencyBoost’s messages give, the AI reading key’s **state** (`set` | `not_set`, from the '
      + 'environment — the key itself is never stored or returned) and the default look, shown and not changed.',
  })
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse({ status: 200, type: PlatformSettingsDto })
  async read(@Ctx() ctx: RequestContext) {
    return this.settings.read(ctx);
  }

  @Put()
  @RequirePermission('platform_settings:update')
  @ApiOperation({
    summary: 'Save the platform’s settings',
    description:
      '*Simpan*: the WhatsApp number as typed, stored as `+62` and its digits; empty or null clears it. Audited as '
      + '`platform_settings.updated` when it changes. Answers the settings.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `whatsappNumber` is not an Indonesian number (`details.field`).'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse({ status: 200, type: PlatformSettingsDto })
  async update(@Ctx() ctx: RequestContext, @Body() dto: UpdatePlatformSettingsDto) {
    return this.settings.update(ctx, dto);
  }
}
