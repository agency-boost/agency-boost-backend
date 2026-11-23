import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { RetireAccountDto, RetirementPreviewDto, RetirementResultDto } from './account-retirement.dto';
import { AccountRetirementService } from './account-retirement.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const WHO = '`account:retire`: the Super Admin alone, as themselves — every tenant role `403 PERM_DENIED`, and any support '
  + 'session `403`.';

/**
 * ***Hapus akun*** (P19.31-T1, T2;
 * [ADR-0289](../../../../docs/04-adr/0289-the-super-admin-may-retire-an-account-so-its-address-and-code-can-be-used-again-and-its-history-stays.md)):
 * Anggota's member sheet ⋯, and the ⋯ beside *Masukkan* on *Menunggu*'s *Belum ada KPM*.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/accounts/:userId/retirement')
export class AccountRetirementController {
  constructor(private readonly retirement: AccountRetirementService) {}

  @Get()
  @RequirePermission('account:retire')
  @ApiOperation({
    summary: 'What deleting an account would end, and what stays',
    description: 'The account, its one live membership (ended by a retirement) and in how many KPMs it has history (which '
      + 'stays), and `refusal` — `{ code, message, details }` — when one of the three applies: an AgencyBoost team account '
      + '(`ACCOUNT_RETIRE_PLATFORM_TEAM`), an owner of a KPM (`ACCOUNT_RETIRE_OWNER`), people reporting to them '
      + `(\`ACCOUNT_RETIRE_HAS_REPORTS\`). Writes nothing. ${WHO}`,
  })
  @ApiResponse({ status: 200, type: RetirementPreviewDto })
  @ApiResponse(refusal(403, '`PERM_DENIED`.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live account with this id: unknown, malformed, or already retired — indistinguishable from one in another office.'))
  async preview(@Ctx() ctx: RequestContext, @Param('userId') userId: string) {
    return this.retirement.preview(ctx, userId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('account:retire')
  @ApiOperation({
    summary: 'Delete (retire) an account so its address and agent code can be used again',
    description: '`{ reason, fullName }`, the name typed in full. **Not erasure**: the account is soft-deleted (who, why), '
      + 'its address moved to `retired+<userId>@akun-dihapus.invalid`, its name kept, its agent code released; its '
      + 'sessions and unused links revoked; its open invitations cancelled; its live membership ended by the removal '
      + 'itself (`member.removed` in that KPM\'s log). Every membership and its history stays. All or nothing: a failure '
      + 'undoes what was written (`account.retire_undone`). Audited `account.retired` — the original address in `before` '
      + `— in the platform's log and the KPM's. ${WHO}`,
  })
  @ApiResponse({ status: 200, type: RetirementResultDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — no reason, or a name that is not theirs (`details.field: fullName`).'))
  @ApiResponse(refusal(403, '`PERM_DENIED`.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live account with this id: unknown, malformed, or already retired — indistinguishable from one in another office.'))
  @ApiResponse(refusal(409, '`ACCOUNT_RETIRE_PLATFORM_TEAM`, `ACCOUNT_RETIRE_OWNER` (`details.kpms`) or '
    + '`ACCOUNT_RETIRE_HAS_REPORTS` (`details.reports`) — nothing written; the sentence says what to do first.'))
  async retire(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() dto: RetireAccountDto) {
    return this.retirement.retire(ctx, userId, dto);
  }
}
