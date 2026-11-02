import { Body, Controller, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RefuseInSupportSession, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { MemberPhoneService } from './member-phone.service';
import { SetMemberPhoneDto } from './org.dto';
import { MemberPhoneDto } from './org.response.dto';

/**
 * **A person's WhatsApp number, set by their leader** (UI V1, 2026-10-30; UI-081, UI-101, D-22).
 *
 * Its own controller under `/members` rather than a route on `OrgController`: a `PUT` on `:membershipId/phone` meets
 * no route there, and the dozen specs that build `OrgController` with each of its services stubbed stay as they are.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('members')
export class MemberPhoneController {
  constructor(private readonly phones: MemberPhoneService) {}

  @Put(':membershipId/phone')
  @RequirePermission('member:update_phone')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Save the WhatsApp number of somebody you coach',
    description:
      '*Isi nomor WhatsApp* on a person in your unit (UI-081, D-22): an AB for their downline, an AAB for their own '
      + 'unit — anybody else, another office\'s member or somebody who has left is `404 NOT_FOUND`. Typed as people type '
      + 'it and stored as `+62` and 9 to 13 digits, else `400 VALIDATION_FAILED` naming `phone`; not clearable here. '
      + '**Only a missing number is filled**: a person who already has one is `409 MEMBER_PHONE_ON_FILE` and keeps it '
      + '(they change their own, `PATCH /auth/me`); the condition is part of the write, so a race cannot overwrite. '
      + 'Saved on the person\'s account, so it is the number they see on their own profile. One `member.phone_updated` '
      + 'audit entry, without the number. **Refused `403 PERM_DENIED` in any support session.**',
  })
  async set(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: SetMemberPhoneDto,
  ): Promise<MemberPhoneDto> {
    return this.phones.set(ctx, membershipId, dto.phone);
  }
}
