import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { PEOPLE_HISTORY_KINDS, PeopleService, type PeopleHistoryFilter } from './people.service';

/** *Riwayat*'s filter. */
export class PeopleHistoryQueryDto {
  @ApiPropertyOptional({ enum: PEOPLE_HISTORY_KINDS, default: 'all', description: '*Semua · Perubahan peran · Dikeluarkan · Pindah unit*.' })
  @IsOptional()
  @IsIn(PEOPLE_HISTORY_KINDS)
  kind?: PeopleHistoryFilter;
}

/** *Pilih leader*: the leader to put them under. */
export class PlaceMemberDto {
  @ApiProperty({ description: 'An active leader of this KPM — for a core leader, themselves or somebody in their downline.' })
  @IsMongoId()
  leaderMembershipId!: string;
}

/**
 * **People's own reads** (P19.20; ADR-0273): *Riwayat*, the three tiles of *KPM admins*, *Pilih leader* and *Riwayat
 * unggah*. Under `/people`, not `/members`, so no route here meets `GET /members/:membershipId` on `OrgController`, and the
 * specs that build that controller with each of its services stubbed stay as they are.
 *
 * Every route is a steward's — the Super Admin inside the KPM, the Owner, an Admin, a core leader — by its permission
 * and by `requireOfficeSteward` in the service; anybody else in the KPM is `404`, a request in no KPM `403`.
 */
@ApiTags('organisation')
@ApiBearerAuth()
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get('history')
  @RequirePermission('member:read_role_change_log')
  @ApiOperation({
    summary: 'Riwayat: role changes, removals, moves and returns, newest first',
    description:
      'All members › *Riwayat*: the old *Removed* and *Role change log* tabs in one list — a role change '
      + '(*Agent → AAB*, the reason, *oleh …*), a removal (*Dikeluarkan*), a move to another leader (*Pindah unit*, from '
      + 'and to by name) and a return — read from the hierarchy’s append-only history. `kind` narrows it: `role`, '
      + '`removed`, `moved`; `all` (the default) is every one. At most 200 lines. Test accounts are not listed. Each line '
      + 'says whether the reader may open the person’s sheet (`openable`: a live membership in their reach).',
  })
  async history(@Ctx() ctx: RequestContext, @Query() query: PeopleHistoryQueryDto) {
    return this.people.list(ctx, query.kind ?? 'all');
  }

  @Get('stewards')
  @RequirePermission('kpm_admin:list')
  @ApiOperation({
    summary: 'KPM admins’ three tiles: the Owner, how many Admins, how many core leaders',
    description:
      '*KPM admins*: the KPM’s Owner by name and photo, and the number of Admins and of core leaders '
      + 'now — active members, test accounts not counted. The Super Admin is never among them. The Owner, an Admin and the '
      + 'Super Admin inside the KPM read it; a core leader holds no `kpm_admin:list`.',
  })
  async stewards(@Ctx() ctx: RequestContext) {
    return this.people.stewards(ctx);
  }

  @Get('imports')
  @RequirePermission('kpm:import_roster')
  @ApiOperation({
    summary: 'Riwayat unggah: the last member files saved',
    description:
      '*Import people* › *Riwayat unggah*: the last 20 files saved in this KPM, newest first — the file, '
      + 'when, by whom, *n baru* (new people, those invited on WhatsApp among them) and *n diperbarui*. A preview, or an '
      + 'import that was undone, is never here.',
  })
  async imports(@Ctx() ctx: RequestContext) {
    return this.people.imports(ctx);
  }

  @Put(':membershipId/placement')
  @RequirePermission('member:add_untagged_to_unit')
  @ApiOperation({
    summary: 'Pilih leader: put somebody who registered, and is in no unit, under a leader now',
    description:
      'All members › *Menunggu* › *Sudah daftar, belum masuk unit*: the person — pending or orphaned, '
      + 'under nobody — joins the leader’s unit at once, as a tag does: today their join date, any request they had open '
      + 'cancelled, their notice sent. A core leader chooses themselves or somebody in their downline; any other leader '
      + 'is `404`. Somebody already in a unit `409 ORG_AGENT_ALREADY_TAGGED`; a leader who cannot lead them the tag’s own '
      + 'refusals. Answers the person as the roster lists them.',
  })
  async place(@Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Body() dto: PlaceMemberDto) {
    return this.people.place(ctx, membershipId, dto.leaderMembershipId);
  }
}
