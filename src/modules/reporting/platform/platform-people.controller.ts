import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { field } from '@/common/validation/violations';
import { PLATFORM_READ } from '@/domain/constants';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';
import { PlatformMemberDetailDto, TestAccountSetDto } from './platform-reads.response.dto';
import { PlatformReads } from './platform-reads.service';
import { TestAccounts } from './test-accounts.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** The body of the *Akun tes* switch (P19.23-T3 AC-1; ADR-0267 §1). */
export class SetTestAccountDto {
  @ApiProperty({ description: '`true` flags the account as a test account; `false` makes it a real person again.' })
  @IsBoolean({ message: field(PLATFORM_READS_REFUSALS.VALIDATION_FAILED.testAccountValue) })
  testAccount!: boolean;
}

/**
 * ***Anggota*'s detail and its *Akun tes* switch** (P19.23-T3 AC-1; the Super Admin spec of 20 November 2026, §6;
 * ADR-0277). Beside the list (`GET /admin/members`, `PlatformReadsController`), which carries no phone and no email: the
 * detail is the one read that does, audited per read, and the switch is the one write here.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class PlatformPeopleController {
  constructor(
    private readonly reads: PlatformReads,
    private readonly testAccounts: TestAccounts,
  ) {}

  @Get('members/:membershipId')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: '*Anggota* — one member’s detail, with their phone and email',
    description:
      'The row as `GET /admin/members` reads it — photo, rung and class, *Owner* and *Admin*, the KPM and its company, '
      + 'the upline, the status, the join date and the last day an activity was logged, and `testAccount` — and the '
      + 'person’s **WhatsApp number and email**, which no row of the list carries. A test account’s detail too: it is how '
      + 'its switch is reached. **Audited per read** as `' + PLATFORM_READ.ACTION.memberDetail + '` (ADR-0207 §5), in the '
      + 'platform’s log and the KPM’s, before the answer is sent.',
  })
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live membership with this id, a malformed one included. A member of any '
    + 'office is read here: another office is never the reason.'))
  @ApiResponse({ status: 200, type: PlatformMemberDetailDto })
  async detail(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.reads.memberDetail(ctx, membershipId);
  }

  @Patch('users/:userId/test-account')
  @RequirePermission('test_account:set')
  @ApiOperation({
    summary: '*Akun tes* — flag or unflag an account as a test account',
    description:
      'ADR-0267 §1: a test account is never listed, counted, summed or ranked in any KPM. Writes `users.testAccount` and '
      + 'the copy on every membership the person holds in any KPM, together; audited as `user.test_account_set`, before '
      + '→ after, naming the KPMs. Setting the value it already has writes nothing. A Super Admin’s own account is `404`.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `testAccount` that is not `true` or `false`, or another field.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role, and a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live account with this id, or a Super Admin’s. An account in any office is '
    + 'written here: another office is never the reason.'))
  @ApiResponse({ status: 200, type: TestAccountSetDto })
  async setTestAccount(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() dto: SetTestAccountDto) {
    return this.testAccounts.set(ctx, userId, dto.testAccount);
  }
}
