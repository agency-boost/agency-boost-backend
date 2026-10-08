import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { AttackPlanQueryDto } from './product-catalog.dto';
import {
  AttackPlanDto, CatalogDocumentUrlDto, CatalogListDto, CatalogProductDto,
} from './product-catalog.response.dto';
import { ProductCatalogService } from './product-catalog.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** The rule every field read keeps: outside the reader's office is the same answer as nothing at all. */
const OUTSIDE =
  'A product of another company, one the office does not keep on and one the company withdrew all answer '
  + 'the same way — deliberately indistinguishable from one in another office: a `403` would confirm the '
  + 'code is somebody’s.';

/** Who may read, and who is turned away before anything is looked up. */
const READERS =
  'Every member of the office — the Owner and the Admin through their field view, an AB, an AAB and an '
  + 'Agent — and a support session acting as one. A Super Admin outside a support session belongs to no '
  + 'office and is refused `403 TENANT_NO_MEMBERSHIP`.';

/**
 * **The Product Catalog's reads** (`/product-catalog`, its drawer at `/product-catalog/[productCode]`;
 * `functional/sales-tools.md`, the Data contract; roles §3.10).
 *
 * Field reads, apart from the settings routes (D-api): those carry an office's drafts and review state,
 * which ADR-0037 keeps from agents. Every word here is the office's **approved** word or the company's.
 * Nothing is written, audited or sent.
 *
 * `:productCode` is declared before `:productCode/documents/:slot/url`, and neither can shadow the
 * other: they differ in depth.
 */
@ApiTags('sales tools')
@ApiBearerAuth()
@Controller('product-catalog')
export class ProductCatalogController {
  constructor(private readonly catalog: ProductCatalogService) {}

  @Get()
  @RequirePermission('product_catalog:read')
  @ApiOperation({
    summary: 'The office’s product shelf',
    description:
      'Every product the office keeps on — the company’s default until the office decided, never a '
      + 'withdrawn one — in the company’s order, under the office’s display names, read live: a product '
      + 'the company withdraws is gone on the next read with no office action. A product in run-off the '
      + 'office keeps on is listed as `closed_to_new_business`. Empty for an office whose company has no '
      + `catalog, or which keeps nothing on. ${READERS}`,
  })
  @ApiResponse({ status: 200, type: CatalogListDto })
  async list(@Ctx() ctx: RequestContext) {
    return this.catalog.catalog(ctx);
  }

  @Get(':productCode')
  @RequirePermission('product_catalog:read')
  @ApiOperation({
    summary: 'One product, as the catalog’s drawer reads it',
    description:
      'Its details, the words to sell it with — the office’s **approved** words field by field, else the '
      + 'company’s — and which of its three documents can be opened. `commissionSchedule` is the company’s, '
      + 'and is left out entirely for a reader without `commission_rates:read`. '
      + `${OUTSIDE} ${READERS}`,
  })
  @ApiResponse({ status: 200, type: CatalogProductDto })
  async product(@Ctx() ctx: RequestContext, @Param('productCode') productCode: string) {
    return this.catalog.product(ctx, productCode);
  }

  @Get(':productCode/documents/:slot/url')
  @RequirePermission('product_catalog:read')
  @ApiOperation({
    summary: 'A product document’s link, valid 300 seconds',
    description:
      'The office’s own file in the slot, else the company’s; `404` when neither exists. Signed only for a '
      + `product the office keeps on. ${OUTSIDE}`,
  })
  @ApiResponse({ status: 200, type: CatalogDocumentUrlDto })
  async documentUrl(
    @Ctx() ctx: RequestContext,
    @Param('productCode') productCode: string,
    @Param('slot') slot: string,
  ) {
    return this.catalog.documentUrl(ctx, productCode, slot);
  }
}

/**
 * **The Sales Attack Plan** (`/attack-plan`; D-scoring, OD-133, OD-134).
 *
 * The recommendation is computed here, once, by one function (`attack-plan.scorer.ts`), over the same
 * shelf the catalog reads; and it is **kept nowhere** (OD-133): no brief, no product and no telemetry is
 * stored, so a plan is a read like any other, and a read-only support session builds one.
 */
@ApiTags('sales tools')
@ApiBearerAuth()
@Controller('attack-plan')
export class AttackPlanController {
  constructor(private readonly catalog: ProductCatalogService) {}

  @Get()
  @RequirePermission('product_catalog:read')
  @ApiOperation({
    summary: 'The Sales Attack Plan for a customer brief',
    description:
      'The product the office keeps on, still issued and serving the brief’s need, that fits the brief '
      + 'best — an eligible age band scores 1 and an eligible budget band 2, highest first, ties in the '
      + 'company’s order, with no minimum — with its verdict (*Good fit* when both bands match, else '
      + '*Check fit* and which bands it is outside), its words, and the brief’s other matches in score '
      + 'order, four of them and a count of the rest. `product: null` when nothing the office keeps on '
      + 'serves the need. With `product`, the reader switched to that alternative: it is shown, re-fitted '
      + `against the brief, and the alternatives are the brief’s other matches. Nothing is stored. ${READERS}`,
  })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `product` names nothing that matches this brief on the office’s shelf: '
    + 'deliberately indistinguishable from one in another office, so a code cannot be probed.',
  ))
  @ApiResponse({ status: 200, type: AttackPlanDto })
  async plan(@Ctx() ctx: RequestContext, @Query() query: AttackPlanQueryDto) {
    return this.catalog.attackPlan(
      ctx, { need: query.need, age: query.age, budget: query.budget }, query.product,
    );
  }
}
