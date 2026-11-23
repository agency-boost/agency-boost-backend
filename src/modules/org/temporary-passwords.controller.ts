import { Body, Controller, Header, HttpCode, HttpStatus, Post, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { TemporaryPasswordsDto, TemporaryPasswordsPreviewDto } from './temporary-passwords.dto';
import { TemporaryPasswordsService } from './temporary-passwords.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const WHO = '`member:issue_temporary_password`: the KPM\'s Owners, and the Super Admin inside the KPM (`X-Kpm-Id`) as its '
  + 'Owner. A KPM Admin is `403 PERM_OWNER_ONLY`; an AB, an AAB, an Agent, the Super Admin outside a KPM and any support '
  + 'session `403 PERM_DENIED`.';

const LISTED = 'Lists each **active** member of the KPM in context whose account is **not yet their own** — still on a '
  + 'temporary password, or never signed in with no address proven — never a test account, a Super Admin or the reader. '
  + '`membershipIds` narrows it to those memberships; one that is not this KPM\'s is `404`.';

/**
 * ***Unduh akun & password (PDF)*** (P19.30-T1, T2;
 * [ADR-0288](../../../../docs/04-adr/0288-a-kpm-may-hand-out-temporary-passwords-in-one-pdf-and-each-person-chooses-their-own-at-first-sign-in.md)):
 * the KPM page's ⋯ for the Super Admin, *All members*' ⋯ for an Owner, and *Import people*'s result. The confirmation
 * asks `preview` how many first; the download issues. **The PDF's body is never logged**: the request log records a
 * request's line and status, never a response's body (`logging.module.ts`).
 */
@ApiTags('members')
@ApiBearerAuth()
@Controller('members/temporary-passwords')
export class TemporaryPasswordsController {
  constructor(private readonly temporary: TemporaryPasswordsService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('member:issue_temporary_password')
  @ApiOperation({
    summary: 'How many people the Akun & password PDF would list',
    description: `${LISTED} **Issues nothing**: what the confirmation says before a download. ${WHO}`,
  })
  @ApiResponse({ status: 200, type: TemporaryPasswordsPreviewDto })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `membershipIds` not a list of 1 to 2,000 ObjectIds.'))
  @ApiResponse(refusal(403, '`PERM_OWNER_ONLY` (a KPM Admin) or `PERM_DENIED`.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — a membership named is not this KPM\'s: indistinguishable from one in another office.'))
  async preview(@Ctx() ctx: RequestContext, @Body() dto: TemporaryPasswordsDto) {
    return this.temporary.preview(ctx, dto.membershipIds);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermission('member:issue_temporary_password')
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Issue temporary passwords and download the Akun & password PDF',
    description: `${LISTED} **Each gets a fresh 10-character password** (no 0 O 1 l I), of which only the hash is written, `
      + 'with `mustChangePassword: true` — so it reaches nothing but `/choose-a-password` until its person chooses their '
      + 'own — and their sessions are ended: **an older PDF stops working for everybody in this one** (OD-478). Answers '
      + 'the PDF (`application/pdf`, A4, `Content-Disposition: attachment`, `Akun-password-{KPM}-{YYYY-MM-DD}.pdf`): No · '
      + 'Nama · Peran · Kode agen · Email · Password, the header row on every page, *"<KPM> · Akun & password · hal. x / '
      + 'n"* at every foot. **No password is kept, logged, audited or answered anywhere else.** Audited '
      + '`member.temporary_passwords_issued` (the count and the memberships) in the KPM\'s log before the answer is sent: '
      + `a failure fails the request. ${WHO}`,
  })
  // The 200 is the file alone (`application/pdf`, `response-map.ts`); the refusals are the envelope, as everywhere.
  @ApiResponse({ status: 200, description: 'The file.' })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `membershipIds` malformed, or nobody to list (`details.listed: 0`).'))
  @ApiResponse(refusal(403, '`PERM_OWNER_ONLY` (a KPM Admin) or `PERM_DENIED`.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — a membership named is not this KPM\'s: indistinguishable from one in another office.'))
  @ApiResponse(refusal(500, '`INTERNAL_ERROR` — the audit entry could not be written, so the file is not served.'))
  async issue(@Ctx() ctx: RequestContext, @Body() dto: TemporaryPasswordsDto) {
    const file = await this.temporary.issue(ctx, dto.membershipIds);
    return new StreamableFile(file.bytes, { type: 'application/pdf', disposition: file.disposition, length: file.bytes.length });
  }
}
