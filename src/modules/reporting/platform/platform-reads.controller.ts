import { Controller, Get, Inject, Optional, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PLATFORM_READ } from '@/domain/constants';
import { CompanyKpmsQueryDto, PlatformAccountsQueryDto, PlatformMembersQueryDto } from './platform-reads.dto';
import { PlatformReads } from './platform-reads.service';
import { AnggotaWaiting } from './anggota-waiting';
import { CompanyKpmsDto, PlatformAccountsPageDto, PlatformMembersPageDto } from './platform-reads.response.dto';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** Every one of these reads: the Super Admin's alone, refused in a support session; audited, or not served. */
const PLATFORM_ONLY = refusal(
  403,
  '`PERM_DENIED` — every tenant role, and a support session (its context is the member’s, holding no platform grant).',
);
const UNRECORDED = refusal(
  500,
  '`INTERNAL_ERROR` — the read’s audit entries could not be written, so the read is not served (ADR-0207 §5).',
);

const AUDITED = (action: string) =>
  ` **Audited per read** as \`${action}\` (ADR-0207 §5): one entry in the platform’s log with the purpose, the `
  + 'filters, the page and the number of rows, and one in each KPM’s whose data it returned, written before the answer '
  + 'is sent. Read-only: nothing in any KPM is written.';

/**
 * **The Super Admin's reads across KPMs** (ADR-0207; P19.4-T3; `functional/kpm-analytics.md` and
 * `functional/tenant-provisioning.md`, the Data contracts): named reads, each reached from one screen. Every figure is
 * the KPM's own, through the function its Owner's page uses; every route is a `GET`.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class PlatformReadsController {
  constructor(
    private readonly reads: PlatformReads,
    /**
     * *Aktif n · Menunggu n · Keluar n* beside the rows (P19.28-T3 AC-4; ADR-0286 §5). Optional so the specs that build
     * this controller for another route need not wire it; the application always gives it.
     */
    @Optional() @Inject(AnggotaWaiting) private readonly waiting: AnggotaWaiting | null = null,
  ) {}

  @Get('members')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: 'All members — every membership on the platform',
    description:
      `*All members* and a KPM's *Anggota* tab (SA UI-010, SA R1): one row per membership, ${PLATFORM_READ.PAGE_SIZE} a `
      + 'page, by name: the person, the company, the KPM, the rung with the *Owner* and *Admin* badges, the leader, the '
      + 'status, the invitation’s state, the join date and the last day an activity was logged. Filtered and searched on '
      + 'the server; `q` matches a name, a phone number or an email address, **neither of which is returned**. A person in '
      + 'two KPMs is two rows. View-only: a row links to its KPM. With every page, *Aktif n · Menunggu n · Keluar n* over the '
      + 'same scope, test accounts never (`chips`); `status=removed` rows carry the day they left '
      + '(`leftOn`), and `testAccount=include` (*Tampilkan akun tes*) lists test accounts beside the others, tagged.'
      + AUDITED(PLATFORM_READ.ACTION.members) + ' The entries name the memberships returned.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `q` shorter than two characters, an unknown `role` or `status`, a '
    + '`page` that is no whole number from 1, an id that is no id, or a parameter of any other name. `details` names it.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: PlatformMembersPageDto })
  async members(@Ctx() ctx: RequestContext, @Query() query: PlatformMembersQueryDto) {
    const [page, chips] = await Promise.all([this.reads.members(ctx, query), this.waiting?.chips(ctx, query)]);
    return chips ? { ...page, chips } : page;
  }

  @Get('users')
  @RequirePermission('platform_members:read')
  @ApiOperation({
    summary: 'Registered accounts — every account, with or without a KPM',
    description:
      `*All members* › *Akun terdaftar* (ADR-0245 §1): every registered account but a Super Admin’s, `
      + `${PLATFORM_READ.PAGE_SIZE} a page, newest registration first — a person who registered and joined no KPM `
      + 'included, whom *All members*’ memberships cannot list. Each row: the name, the email, the insurer it registered '
      + 'with, the day it registered, whether the address is verified, the day it last signed in, and how many KPMs it '
      + 'is active or pending in. `q` matches a name or an email; `kpm=none` is *Tanpa KPM*, `kpm=some` *Punya KPM*. '
      + 'Never a phone, a birth date or a gender. View-only. **Audited per read** as '
      + `\`${PLATFORM_READ.ACTION.accounts}\` (ADR-0207 §5): one entry in the platform’s log with the purpose, the filters, `
      + 'the page, the number of rows and the accounts returned, written before the answer is sent.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `q` shorter than two characters, a `kpm` other than `none` or `some`, '
    + 'a `page` that is no whole number from 1, or a parameter of any other name. `details` names it.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: PlatformAccountsPageDto })
  async accounts(@Ctx() ctx: RequestContext, @Query() query: PlatformAccountsQueryDto) {
    return this.reads.accounts(ctx, query);
  }

  /*
   * `GET /admin/analytics/kpms` (the KPM comparison) and `GET /admin/tenants/:id/data` (*Data bulanan*) were here, and
   * before them *Lihat sebagai KPM*'s two reads (removed with KPM Analytics, P19.19-T4). **Retired 2026-11-20 by the
   * console's rebuild** (P19.23-T1, T2; ADR-0277): the Dashboard's *Adopsi per KPM* (`GET /admin/dashboard`) replaces the
   * comparison, and inside a KPM the Owner's own *Data upload* replaces *Data bulanan* (ADR-0268 §3).
   */
  @Get('companies/:companyId/kpms')
  @RequirePermission('platform_kpm_figures:read')
  @ApiOperation({
    summary: '*KPM & data* — the company’s KPMs for a month',
    description:
      'The company page’s *KPM & data* tab (A2): three tiles — the KPMs and their Owners signed in, the members and those '
      + 'never signed in, the KPMs complete for the month — and per KPM its manpower, MAA, APE and recruitment from '
      + 'January through the month, its data status and its peer status (the D4 rule: other KPMs of the company complete '
      + 'for the month, three needed; *"Belum cukup KPM pembanding"* under three). Every figure through the Overview’s '
      + 'own functions over each KPM. `month` is the latest any KPM uploaded when absent.'
      + AUDITED(PLATFORM_READ.ACTION.companyKpms),
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `month` that is no month, or a parameter of any other name.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no company with this id, or the Template library, which holds no KPM — as another office’s would be.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse(UNRECORDED)
  @ApiResponse({ status: 200, type: CompanyKpmsDto })
  async companyKpms(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Query() query: CompanyKpmsQueryDto) {
    return this.reads.companyKpmsAcrossTenants(ctx, companyId, query.month);
  }
}
