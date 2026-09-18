import { Body, Controller, Delete, Get, Param, Patch, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import {
  AttachProductDocumentDto, SetProductActiveDto, SaveProductOverridesDto,
} from './kpm-product.dto';
import { KpmProductView } from './kpm-product.service';
import { KpmProductService } from './kpm-product.service';
import { KpmProductDto, SignedUrlDto } from './kpm-product.response.dto';

/**
 * What this office sells, and the words it sells it with (P5-T5, ADR-0033).
 *
 * **Every route is the office's own settings permission** (`tenant_config:write`, ADR-0027): the
 * Owner and the Admin decide together, and a leader, an agent and a **Super Admin** are all
 * refused — a Super Admin writes the company's catalog, never an office's decisions about it.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings/products')
export class KpmProductController {
  constructor(private readonly products: KpmProductService) {}

  @Get()
  @RequirePermission('tenant_config:read')
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
      'Only the display name and the seven script fields. A body naming anything else is refused '
      + '**by name** — an edit that half-saved leaves nobody able to find out which half. Touching '
      + 'the script puts the override back to **pending**: the office approves its own before '
      + 'agents read it (ADR-0037).',
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
  @RequirePermission('tenant_config:read')
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
}
