import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { CreateProductDto } from './product.dto';
import { SaveProductDraftDto } from './product-draft.dto';
import { ProductDraftService } from './product-draft.service';
import { ProductDraftDto, ProductResponseDto } from './product.response.dto';

/**
 * **A product's draft, and the new products no KPM has yet** (P19.23-T4 AC-3; ADR-0278 §4): *Produk & proposal* on a
 * company's page. Beside the catalogue's own routes (`ProductController`), at the same address, so a screen reads one
 * product family; its own controller so nothing that builds the catalogue's needs to know about drafts.
 *
 * The Super Admin's alone: `product_catalog:crud`, which no tenant role holds. Publishing is *Terbitkan ke KPM*'s
 * (`POST /admin/companies/:companyId/publication`).
 */
@ApiTags('products (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/products')
export class ProductDraftController {
  constructor(private readonly drafts: ProductDraftService) {}

  @Get('drafts')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Every product’s draft and release',
    description:
      'Per product, in shelf order: `state` — `unpublished` (a new product no KPM has yet), `draft` (published, edits '
      + 'waiting) or `published` —, `draft` (the edits by field, or null), `releasedTo` (null: every KPM of the company; '
      + 'else the KPMs it was published to), `firstPublishedAt`, `alsoFits` (*Juga sesuai*, as published) and `brochure` '
      + '(the company’s brochure by its label, or null). 404 for a company that does not exist.',
  })
  async list(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string) {
    return this.drafts.list(ctx, companyId);
  }

  @Post('drafts')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'A new product, released to no KPM yet',
    description:
      '*+ Produk baru*: made as `POST …/products` makes one — the code typed once, refused when this company has used '
      + 'it — and released to nobody (`releasedTo: []`), so no KPM sees it until *Terbitkan ke KPM* adds it to the KPMs '
      + 'chosen. Audited `product.created` and `product.draft_created`.',
  })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  async create(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Body() dto: CreateProductDto) {
    return this.drafts.create(ctx, companyId, { ...dto });
  }

  @Put(':productId/draft')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Save a product’s draft',
    description:
      '*Simpan draf*: the fields sent merged over the draft already saved, each checked as the product’s own write '
      + 'checks it; the product as a whole when the draft is published. A product no KPM has yet is written at once '
      + 'instead (nobody reads it). `alsoFits` must name this company’s other products (400). 400 for nothing sent; '
      + '404 for a product that is not this company’s. Audited `product.draft_saved`, before and after.',
  })
  @ApiResponse({ status: 200, type: ProductDraftDto })
  @ApiResponse({ status: 400, type: ApiErrorEnvelope, description: '`VALIDATION_FAILED` — nothing sent, or *Juga sesuai* names a stranger.' })
  async save(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
    @Body() dto: SaveProductDraftDto,
  ) {
    return this.drafts.save(ctx, companyId, productId, { ...dto });
  }

  @Delete(':productId/draft')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Discard a product’s draft',
    description: 'The published product stands as it is. 400 where no draft waits; 404 for another company’s product. '
      + 'Audited `product.draft_discarded`.',
  })
  async discard(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
  ) {
    return this.drafts.discard(ctx, companyId, productId);
  }
}
