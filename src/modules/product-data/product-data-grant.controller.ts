import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ProductDataChangesQuery, SetProductDataGrantDto } from './product-data-grant.dto';
import { ProductDataGrantService } from './product-data-grant.service';
import { ProductDataCompaniesService } from './product-data-companies.service';

/**
 * ***Kelola data produk*, the Super Admin's** (ADR-0260 §4, §6; P19.15-T4 AC-2): who holds it for which insurers, giving
 * and removing it, and *Perubahan oleh pengelola*. Under `/admin`, the platform console's, and the Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/product-data-grants')
export class ProductDataGrantController {
  constructor(private readonly grants: ProductDataGrantService) {}

  @Get()
  @RequirePermission('product_data_grant:read')
  @ApiOperation({
    summary: 'Who holds Kelola data produk, for which insurers',
    description:
      'ADR-0260 §4: every live grant, newest first — the person, their KPM now, the insurers ticked (A '
      + 'to Z), who gave it and when, and `holds`: `false` for a grant kept on record for somebody who is no longer an '
      + 'active KPM Owner or KPM Admin, which grants nothing until they are one again. The Super Admin\'s alone.',
  })
  async list(@Ctx() ctx: RequestContext) {
    return this.grants.list(ctx);
  }

  @Get('changes')
  @RequirePermission('product_data_grant:read')
  @ApiOperation({
    summary: 'Perubahan oleh pengelola: what product data managers changed',
    description:
      'ADR-0260 §6 (the P1b spec\'s *Rules*): every change to a company\'s premium tables, product rules, '
      + 'uploads and illustrations (`rate_table.*`, `product_rules.*`, `intake.*`, `illustration.*`) by somebody who holds '
      + 'or held *Kelola data produk*, newest first, 50 a page with `page.nextCursor`. Read from the audit log in every '
      + 'scope: each line names the action in words, the actor and their KPM, the company and the product, and carries '
      + 'the audit row\'s id and the scope it is in. A malformed `cursor` is `400 VALIDATION_FAILED`.',
  })
  async changes(@Ctx() ctx: RequestContext, @Query() query: ProductDataChangesQuery) {
    return this.grants.changes(ctx, query.cursor);
  }

  @Put(':userId')
  @RequirePermission('product_data_grant:manage')
  @ApiOperation({
    summary: 'Give Kelola data produk, or change its insurers',
    description:
      'ADR-0260 §1, §4: `{ companyIds }`, at least one insurer company. Gives the person a grant, or '
      + 'replaces the insurers of their live one; the same insurers again change nothing. In force from the person\'s '
      + 'next request. `404 NOT_FOUND` for an unknown account; `400 VALIDATION_FAILED` for an empty list, a repeated id or '
      + 'a company that is not an insurer (named in `details.companyId`); `409 PRODUCT_DATA_GRANT_NOT_ELIGIBLE` for '
      + 'somebody who is not an active KPM Owner or KPM Admin. Audited `product_data_grant.granted` or `.changed`, before '
      + 'and after. Refused in any support session.',
  })
  async set(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() dto: SetProductDataGrantDto) {
    return this.grants.set(ctx, userId, dto.companyIds);
  }

  @Delete(':userId')
  @RequirePermission('product_data_grant:manage')
  @ApiOperation({
    summary: 'Remove Kelola data produk',
    description:
      'ADR-0260 §4: at once — from the person\'s next request they hold nothing, and *Data produk* '
      + 'leaves their menu at their next session read. The grant is kept with `revokedAt`; audited '
      + '`product_data_grant.revoked`. `404 NOT_FOUND` when they hold no live grant. Refused in any support session.',
  })
  async revoke(@Ctx() ctx: RequestContext, @Param('userId') userId: string) {
    return this.grants.revoke(ctx, userId);
  }
}

/**
 * ***Data produk*'s companies, for whoever reads it** (ADR-0260 §5; P19.15-T4 AC-2, AC-3): under `/product-data`, beside
 * the company *Proposal* tab's own routes, so a product data manager — a KPM Owner or Admin — reaches it.
 */
@ApiTags('product data')
@ApiBearerAuth()
@Controller('product-data/companies')
export class ProductDataCompaniesController {
  constructor(private readonly companies: ProductDataCompaniesService) {}

  @Get()
  @RequirePermission('product_data:read')
  @ApiOperation({
    summary: 'The insurers whose product data you may open, and whether in full',
    description:
      'ADR-0260 §5: what `/kpm/data-produk` mounts the company *Proposal* tab for. A KPM Owner or '
      + 'Admin: their own KPM\'s company, `canManage: false` unless their *Kelola data produk* ticks it, and every insurer '
      + 'it ticks with `canManage: true`; the own company first, then A to Z. The Super Admin: every insurer. Read from the '
      + 'grant as this request resolved it, so a removal shows at once. Agents and leaders `403 PERM_DENIED`; a support '
      + 'session reads as its member, `canManage` always `false`.',
  })
  async readable(@Ctx() ctx: RequestContext) {
    return this.companies.readable(ctx);
  }
}
