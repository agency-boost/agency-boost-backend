import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  AttachProductDocumentDto, RejectScriptDto, SetProductActiveDto, SaveProductOverridesDto,
} from './kpm-product.dto';
import { KpmProductView } from './kpm-product.service';
import { KpmProductService } from './kpm-product.service';
import {
  EffectiveScriptDto, KpmProductDto, SignedUrlDto,
} from './kpm-product.response.dto';

/**
 * What this office sells, and the words it sells it with (P5-T5, ADR-0033).
 *
 * **Every route is the office's own settings permission** (`tenant_config:write`, ADR-0027): the
 * Owner and the Admin decide together, and a leader, an agent and a **Super Admin** are all
 * refused — a Super Admin writes the company's catalog, never an office's decisions about it.
 *
 * **The four reads are `product_settings:read`, the Owner's and the Admin's** (the Phase 14 exit
 * review): they carry the office's drafts, its review state and a rejection's reason, which ADR-0037
 * keeps from agents. They sat on `tenant_config:read`, which every member holds; a field member reads
 * the office's approved words through `/product-catalog` and `/attack-plan` instead.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/products')
export class KpmProductController {
  constructor(private readonly products: KpmProductService) {}

  @Get()
  @RequirePermission('product_settings:read')
  @ApiOperation({
    summary: 'This office’s shelf',
    description:
      'Every product of this office’s company, in the company’s order, with this office’s '
      + 'decisions laid over it. Each value says whether this office chose it or inherited it, so '
      + 'a screen can offer *"use my company’s again"* on exactly the fields it applies to.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto, isArray: true })
  async list(@Ctx() ctx: RequestContext): Promise<KpmProductView[]> {
    return this.products.list(ctx);
  }

  @Put(':productId/active')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Sell this product, or stop',
    description:
      '`null` gives the decision back to the company’s default — which is not the same as writing '
      + 'that default’s current value, because the company may change it later. A withdrawn '
      + 'product cannot be activated.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto })
  async setActive(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Body() dto: SetProductActiveDto,
  ) {
    return this.products.setActive(ctx, productId, dto.active ?? null);
  }

  @Patch(':productId/overrides')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Replace some of the company’s words with this office’s',
    description:
      'Only the display name, the description and the seven script fields. A body naming anything '
      + 'else is refused **by name** — an edit that half-saved leaves nobody able to find out which '
      + 'half. Touching the script or the description puts the override back to **pending**: the '
      + 'office approves its own before agents read it (ADR-0037, ADR-0120). `description: null` '
      + 'gives the description back to the company.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto })
  async saveOverrides(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Body() dto: SaveProductOverridesDto,
  ) {
    return this.products.saveOverrides(ctx, productId, { ...dto });
  }

  @Delete(':productId/overrides/:field')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Give one field back to the company',
    description:
      'An **unset**, not a copy of the company’s value today. Copying would look identical now and '
      + 'diverge silently the moment the company changed its wording — which is the prototype’s '
      + 'own defect, where Reset copies the default into the form.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto })
  async resetOverride(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Param('field') field: string,
  ) {
    return this.products.resetOverride(ctx, productId, field);
  }

  @Put(':productId/documents/:slot')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Attach this office’s own file to one slot',
    description:
      'Each of the three slots is independent: filling one leaves the other two on the company’s.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto })
  async setDocument(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Param('slot') slot: string,
    @Body() dto: AttachProductDocumentDto,
  ) {
    return this.products.setDocument(ctx, productId, slot, dto);
  }

  @Delete(':productId/documents/:slot')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Use the company’s document for this slot again',
    description:
      'The office’s file is **released, never deleted** — somebody may put it back, and deleting '
      + 'a file because it stopped being referenced is a decision nobody made.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto })
  async resetDocument(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Param('slot') slot: string,
  ) {
    return this.products.resetDocument(ctx, productId, slot);
  }

  @Get(':productId/documents/:slot/url')
  @RequirePermission('product_settings:read')
  @ApiOperation({
    summary: 'A short-lived URL for one slot',
    description:
      'Signed, 300 seconds. Which registry answers follows which half holds the file, never what '
      + 'the caller asks for.',
  })
  @ApiResponse({ status: 200, type: SignedUrlDto })
  async documentUrl(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Param('slot') slot: string,
  ) {
    return { url: await this.products.documentUrl(ctx, productId, slot) };
  }

  // ------------------------------------------- the script approval gate (P5-T10, ADR-0037)

  @Get('script-reviews')
  @RequirePermission('product_settings:read')
  @ApiOperation({
    summary: 'The script overrides waiting on somebody here',
    description:
      'A queue rather than a hunt through the whole shelf: the point of a gate is that whoever '
      + 'holds it can see what is behind it. **Reading it is `product_settings:read`, not '
      + '`sales_script:approve`** — every row is already in `GET /kpm/settings/products`, so a '
      + 'stricter grant on the same data would be theatre, and somebody who wrote a script has '
      + 'every reason to see it waiting. Deciding is the separate grant. A field member is refused: '
      + 'the queue is the office\'s drafts.',
  })
  @ApiResponse({ status: 200, type: KpmProductDto, isArray: true })
  async pendingReviews(@Ctx() ctx: RequestContext) {
    return this.products.pendingReviews(ctx);
  }

  @Post(':productId/script/approve')
  @RequirePermission('sales_script:approve')
  @ApiOperation({
    summary: 'Approve this office’s script override',
    description:
      'The approved words are **frozen at this moment**, so a later edit cannot change what agents '
      + 'are already reading — and that edit returns the row to pending. **This is a gate, not an '
      + 'independent review** (ADR-0037): the office writes and approves, and what it guarantees is '
      + 'that no half-finished script reaches an agent and that every one carries a name and a time.',
  })
  @ApiResponse({ status: 201, type: KpmProductDto })
  async approveScript(@Ctx() ctx: RequestContext, @Param('productId') productId: string) {
    return this.products.approveScript(ctx, productId);
  }

  @Post(':productId/script/reject')
  @RequirePermission('sales_script:approve')
  @ApiOperation({
    summary: 'Send the script back, with a reason',
    description:
      'The reason is required: "no" on its own is not something the person who wrote it can act on, '
      + 'and a rejection nobody can act on is a script that stays unapproved for ever.',
  })
  @ApiResponse({ status: 201, type: KpmProductDto })
  async rejectScript(
    @Ctx() ctx: RequestContext,
    @Param('productId') productId: string,
    @Body() dto: RejectScriptDto,
  ) {
    return this.products.rejectScript(ctx, productId, dto.reason);
  }

  @Get(':productId/script/effective')
  @RequirePermission('product_settings:read')
  @ApiOperation({
    summary: 'The script and the description an agent is actually served',
    description:
      'The office’s own words **only when approved**; otherwise the company’s, which the company '
      + 'published and is therefore already the company’s word — for the description, the '
      + 'company’s tagline (OD-136). The settings screen’s comparison of what agents read today; '
      + 'an agent’s own screens read the same rule through `/product-catalog` and `/attack-plan`.',
  })
  @ApiResponse({ status: 200, type: EffectiveScriptDto })
  async effectiveScript(
    @Ctx() ctx: RequestContext, @Param('productId') productId: string,
  ) {
    return this.products.effectiveScript(ctx, productId);
  }
}
