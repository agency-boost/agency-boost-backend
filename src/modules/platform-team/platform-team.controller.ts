import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { AddSuperAdminDto } from './platform-team.dto';
import { SuperAdminRowDto } from './platform-team.response.dto';
import { PlatformTeamService } from './platform-team.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * ***Tim Super Admin*** (P19.23-T6 AC-2; ADR-0279): `/admin/platform/team`. Every answer is the team as it now stands, so
 * the section redraws from it. The Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/platform/team')
export class PlatformTeamController {
  constructor(private readonly team: PlatformTeamService) {}

  @Get()
  @RequirePermission('super_admin:read')
  @ApiOperation({
    summary: 'Every Super Admin',
    description: '*Tim Super Admin*: name, email, the account’s status and whether it is the reader (*Anda*), by name.',
  })
  @ApiResponse({ status: 200, type: SuperAdminRowDto, isArray: true })
  async list(@Ctx() ctx: RequestContext) {
    return this.team.list(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('super_admin:grant')
  @ApiOperation({
    summary: 'Make an account a Super Admin',
    description:
      '*Tambah Super Admin*: the account with this email — existing, not deactivated, its address verified, and holding no '
      + 'live KPM membership (a Super Admin is never a KPM role). Nobody is invited and no account is made. Someone who '
      + 'already is one changes nothing. Audited as `super_admin.granted`. Answers the team.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `email` is not an email address.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse(refusal(409, '`SUPER_ADMIN_HAS_MEMBERSHIP` — the account is a member of a KPM.'))
  @ApiResponse(refusal(422, '`SUPER_ADMIN_NO_ACCOUNT` (`details.reason`: `no_account` | `deactivated`) or '
    + '`SUPER_ADMIN_UNVERIFIED` — `details.field` is `email`.'))
  @ApiResponse({ status: 200, type: SuperAdminRowDto, isArray: true })
  async add(@Ctx() ctx: RequestContext, @Body() dto: AddSuperAdminDto) {
    return this.team.add(ctx, dto.email);
  }

  @Delete(':userId')
  @RequirePermission('super_admin:revoke')
  @ApiOperation({
    summary: 'Take the Super Admin role away',
    description:
      '*Cabut*: the account keeps its login and loses the role at its next request. Never your own (`SUPER_ADMIN_SELF`), '
      + 'never the last active Super Admin (`SUPER_ADMIN_LAST`). Audited as `super_admin.revoked`. Answers the team.',
  })
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no Super Admin with this id: nobody’s, or an account in an office (another '
    + 'office’s included), answered alike.'))
  @ApiResponse(refusal(409, '`SUPER_ADMIN_SELF` or `SUPER_ADMIN_LAST`.'))
  @ApiResponse({ status: 200, type: SuperAdminRowDto, isArray: true })
  async revoke(@Ctx() ctx: RequestContext, @Param('userId') userId: string) {
    return this.team.revoke(ctx, userId);
  }
}
