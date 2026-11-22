import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RefuseInSupportSession, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { CompleteMemberPersonalDto, MemberPersonalCompletedDto } from './member-personal.dto';
import { MemberPersonalService } from './member-personal.service';

/**
 * **The member sheet's edits** (P19.20-T2; ADR-0273 §3, amending ADR-0248 §3) — every field of *Profil* and *Demografi*
 * but *Peran*, *Leader*, *Group* and *Unit*, which have writes of their own.
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
    summary: 'Change any field of a member’s details: the member sheet',
    description:
      'The member sheet (ADR-0273 §3): the Owner, an Admin, the Super Admin inside the KPM, or a core leader for somebody '
      + '**strictly below them**, changes a member’s join date, company join month, work status, agent code, birth date, '
      + 'gender, WhatsApp number or email — at least one, each optional, **any value, not only a blank** (ADR-0273 §3). '
      + 'A member of another office, one who has left, one outside a core leader’s downline, or an id that is none is '
      + '`404 NOT_FOUND`. The shapes and the rules are the profile’s and the joining’s, the dates measured against today '
      + 'in the office’s calendar (`400 VALIDATION_FAILED`, `details.field`); none is clearable. An agent code held by '
      + 'somebody else at the insurer is `409 AGENT_CODE_TAKEN`; an address held by another account `409 '
      + 'AUTH_EMAIL_TAKEN`; **an email is changed only for somebody who has never signed in** — `409 '
      + 'MEMBER_EMAIL_SIGNED_IN` otherwise (OD-400). The account’s fields are saved on the person’s account, so they are '
      + 'what the person sees on their own profile; the agent code on the account and on this office’s membership. One '
      + '`member.details_edited` audit entry with each changed field **before and after**; a value sent as stored changes '
      + 'nothing. Answers what changed, the details and the member as now read. **Refused `403 PERM_DENIED` in any '
      + 'support session.**',
  })
  async complete(
    @Ctx() ctx: RequestContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: CompleteMemberPersonalDto,
  ): Promise<MemberPersonalCompletedDto> {
    return this.personal.complete(ctx, membershipId, dto);
  }
}
