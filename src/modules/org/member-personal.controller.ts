import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RefuseInSupportSession, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { CompleteMemberPersonalDto, MemberPersonalCompletedDto } from './member-personal.dto';
import { MemberPersonalService } from './member-personal.service';

/**
 * **The office fills a member's blank personal data** (ADR-0248 §3; the client's TI-2) — *Lengkapi data* on the member
 * page.
 *
 * Its own controller under `/members`, as `MemberPhoneController` is: a `PATCH` on `:membershipId/personal` meets no
 * route on `OrgController`, and the specs that build `OrgController` with each of its services stubbed stay as they are.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('members')
export class MemberPersonalController {
  constructor(private readonly personal: MemberPersonalService) {}

  @Patch(':membershipId/personal')
  @RequirePermission('member:complete_personal')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Fill a member’s blank personal data',
    description:
      '*Lengkapi data* on the member page: the Owner or an Admin fills a member’s **blank** birth date, gender, company '
      + 'join month, work status or WhatsApp number — at least one, each optional. A member of another office, one who '
      + 'has left, or an id that is none is `404 NOT_FOUND`. The shapes and the rules are the profile’s, the dates '
      + 'measured against today in the office’s calendar (`400 VALIDATION_FAILED`, `details.field`); none is clearable. '
      + '**Only a blank field is filled**: one already on file is `409 MEMBER_DETAIL_ON_FILE` with `details.fields`, and '
      + 'nothing is written — a recorded value is the person’s own to change (`PATCH /auth/me`). Each write carries the '
      + 'condition, so a race cannot overwrite. The account’s fields are saved on the person’s account, so they are what '
      + 'the person sees on their own profile. One `member.personal_completed` audit entry, naming the fields and never '
      + 'their values. **Refused `403 PERM_DENIED` in any support session.**',
  })
  async complete(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: CompleteMemberPersonalDto,
  ): Promise<MemberPersonalCompletedDto> {
    return this.personal.complete(ctx, membershipId, dto);
  }
}
