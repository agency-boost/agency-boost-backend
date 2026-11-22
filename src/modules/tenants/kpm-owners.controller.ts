import { Controller, Delete, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { KpmOwnersService } from './kpm-owners.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **A KPM's owners, from inside it** (P19.27-T1 AC-4, T2, T4; [ADR-0285](../../../../docs/04-adr/0285-a-kpm-has-one-or-more-owners.md)
 * §4; F-2 (21 Nov)): *Tambah owner* and *Hapus sebagai owner*, on the KPM page's *KPM Owner · n* (the Super Admin, inside
 * the KPM) and on People › *KPM admins* (an owner). Tenant-scoped: the membership is the reader's KPM's, through the
 * scoped repository — another KPM's is `404`. Both answer the owners as the section lists them (`KpmOwnerList`); the
 * list itself is read with the page (`GET /people/stewards`, `GET /admin/tenants/:id/people`).
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('members')
export class KpmOwnersController {
  constructor(private readonly owners: KpmOwnersService) {}

  @Post(':membershipId/owner')
  @RequirePermission('kpm_owner:grant')
  @ApiOperation({
    summary: 'Make a member of this KPM one of its owners',
    description:
      '*Jadikan owner* (F-2): every owner holds the same full KPM Owner rights. The Super Admin inside the KPM, or an '
      + 'owner of it. Idempotent: an owner already is answered as one. The member may be active or invited (`pending`). '
      + 'Audited `kpm.owner_added` in the KPM\'s log. Answers `{ owners, canManage }`, the owners in order of `since`.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: '`{ owners: KpmOwnerView[], canManage }`.' })
  @ApiResponse(refusal(403, '`PERM_OWNER_ONLY` — a KPM Admin: adding owners is the owners\' own (`kpm_owner:grant`); '
    + '`PERM_DENIED` for anybody else.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live membership with that id in this KPM, answered exactly as one in another office.'))
  async add(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.owners.addMember(ctx, membershipId);
  }

  @Delete(':membershipId/owner')
  @RequirePermission('kpm_owner:revoke')
  @ApiOperation({
    summary: 'Remove one of this KPM\'s owners — never the last',
    description:
      '*Hapus sebagai owner* (F-2): the person stays a member, their rung and leader unchanged. The Super Admin inside '
      + 'the KPM, or another owner of it — an owner never removes themselves. Audited `kpm.owner_removed`. Answers `{ '
      + 'owners, canManage }`.',
  })
  @ApiResponse({ status: HttpStatus.OK, description: '`{ owners: KpmOwnerView[], canManage }`.' })
  @ApiResponse(refusal(403, '`PERM_OWNER_ONLY` — a KPM Admin, or an owner naming themselves.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no membership with that id in this KPM, or it is not an owner; one in another office is '
    + 'answered alike.'))
  @ApiResponse(refusal(409, '`KPM_LAST_OWNER` — the KPM\'s only owner: add another first. `details: { kpmId, userId }`.'))
  async remove(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string) {
    return this.owners.removeMember(ctx, membershipId);
  }
}
