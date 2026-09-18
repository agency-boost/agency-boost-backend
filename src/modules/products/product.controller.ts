import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { scopeFor } from '@/modules/rbac/permissions';
import {
  CloseToNewBusinessDto, CreateProductDto, ReorderProductsDto, UpdateProductDto,
} from './product.dto';
import { ProductResponseDto } from './product.response.dto';
import { ProductService } from './product.service';

/**
 * A company's product catalog (P5-T4, ADR-0033).
 *
 * **Every route is Super Admin's**, and it hangs under the company rather than at a flat
 * `/admin/products`: a product belongs to one insurer, and the prototype's global shelf could not
 * say which (parity I-62). The office side — what an office sells, and its overrides — is P5-T5.
 */
@ApiTags('products (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/products')
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Get()
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'The company\'s whole catalog',
    description:
      'In `sortOrder`, withdrawn rows included — a withdrawn product still has to render in every '
      + 'record that names it. `commissionSchedule` is absent for a reader without '
      + '`commission_rates:read`.',
  })
  @ApiResponse({ status: 200, type: ProductResponseDto, isArray: true })
  async list(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string) {
    return this.products.list(companyId, { withCommission: this.mayReadCommission(ctx) });
  }

  @Post()
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Add a product',
    description:
      'The code is typed once and never changes. A code this company has used — withdrawn rows '
      + 'counted — is refused: reusing one would change the meaning of every policy still '
      + 'pointing at it.',
  })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  async create(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(ctx, companyId, { ...dto });
  }

  /*
   * Before `:productId`, because a parameter declared first would swallow the literal segment and
   * `reorder` would arrive as a product id that does not exist.
   */
  @Patch('reorder')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Set the order of the shelf',
    description:
      'The whole shelf, once each. Bumps no version: a catalog\'s order is presentation, and two '
      + 'people dragging rows should not each produce a new version of every product.',
  })
  @ApiResponse({ status: 200, type: ProductResponseDto, isArray: true })
  async reorder(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Body() dto: ReorderProductsDto,
  ) {
    return this.products.reorder(ctx, companyId, dto.productIds);
  }

  @Patch(':productId')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Change a product',
    description:
      'Everything but the identity and the lifecycle. There is no `code` here — it never changes — '
      + 'and no `lifecycle`, which moves through the three routes below.',
  })
  @ApiResponse({ status: 200, type: ProductResponseDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(ctx, companyId, productId, { ...dto });
  }

  @Post(':productId/close-to-new-business')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Close a product to new business',
    description:
      'It stays sold against existing policies and stays readable everywhere it is named. Name the '
      + 'successor where there is one.',
  })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  async closeToNewBusiness(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
    @Body() dto: CloseToNewBusinessDto,
  ) {
    return this.products.setLifecycle(
      ctx, companyId, productId, 'closed_to_new_business', dto.replacedByProductId ?? null,
    );
  }

  @Post(':productId/withdraw')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Withdraw a product',
    description:
      'Every office of this company stops selling it on their next read, with no Owner pressing '
      + 'publish — which is what a product pulled for regulatory reasons needs.',
  })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  async withdraw(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
    @Body() dto: CloseToNewBusinessDto,
  ) {
    return this.products.setLifecycle(
      ctx, companyId, productId, 'withdrawn', dto.replacedByProductId ?? null,
    );
  }

  @Post(':productId/reopen')
  @RequirePermission('product_catalog:crud')
  @ApiOperation({
    summary: 'Put a product back on sale',
    description: 'Active again, and its successor forgotten. Offices keep whatever they had decided.',
  })
  @ApiResponse({ status: 201, type: ProductResponseDto })
  async reopen(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Param('productId') productId: string,
  ) {
    return this.products.setLifecycle(ctx, companyId, productId, 'active', null);
  }

  /**
   * Commission is a separate read (ADR-0038), so the catalog leaves it out entirely rather than
   * sending it for a screen to remember to hide.
   */
  private mayReadCommission(ctx: RequestContext): boolean {
    return scopeFor(ctx, 'commission_rates:read') !== null;
  }
}
