import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, StreamableFile, UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { FileUploadInterceptor, type FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { PRODUCT_DATA } from '@/domain/constants';
import {
  ActivateRateTableDto, ProductRulesDto, RateTableTemplateQueryDto, RateTestsDto, TryProductDto, UpdateRateTableDto,
  UploadRateTableDto,
} from './product-data.dto';
import { ProductDataAccess } from './product-data-access.service';
import {
  ProductDataDetailDto, ProductDataOverviewDto, ProductTryDto, RateTableViewDto,
} from './product-data.response.dto';
import { PRODUCT_DATA_REFUSALS } from './product-data.messages';
import { ProductDataService, type TryInput } from './product-data.service';
import { ProductRulesService } from './product-rules.service';
import { RateTableService } from './rate-table.service';

/** **A premium table as a file** (P19.15-T1 AC-1): Excel or CSV, at most `PRODUCT_DATA.UPLOAD_MAX_BYTES`, as bytes. */
const RateTableUpload = FileUploadInterceptor({
  maxBytes: PRODUCT_DATA.UPLOAD_MAX_BYTES,
  tooLarge: PRODUCT_DATA_REFUSALS.ASSET_TOO_LARGE.tableTooLarge({ mb: PRODUCT_DATA.UPLOAD_MAX_BYTES / 1024 / 1024 }),
  notAForm: PRODUCT_DATA_REFUSALS.VALIDATION_FAILED.notAForm,
});

/**
 * **An insurer's proposal data: the Proposal tab** (P19.15-T1, T4 AC-1; ADR-0258; `functional/proposal.md`, *Proposal
 * data per insurer*). Under `/product-data/companies/:companyId`, not `/admin`, so the holders of *Kelola data produk*
 * (ADR-0260) reach it as the Super Admin does. **Every route asks `ProductDataAccess` for the company** after the
 * guard's permission: a company the reader may not read is `404`; a write by a reader who may only read it, `403
 * PERM_DENIED`. A view-only session reads and writes nothing (`product_data:manage` is not read-like).
 */
@ApiTags('product data (Proposal tab)')
@ApiBearerAuth()
@Controller('product-data/companies/:companyId')
export class ProductDataController {
  constructor(
    private readonly access: ProductDataAccess,
    private readonly data: ProductDataService,
    private readonly tables: RateTableService,
    private readonly rules: ProductRulesService,
  ) {}

  @Get('products')
  @RequirePermission('product_data:read')
  @ApiOperation({
    summary: 'The Proposal tab: four counters and one row per product',
    description: '*Siap hitung*, *Ketik manual*, *Perlu dicek*, *Ditarik*; each base product with its calculation, its '
      + 'premium table in force (or none), its illustration and its status, *Perlu dicek* first. `canManage` says whether '
      + 'the reader may change anything here.',
  })
  @ApiResponse({ status: 200, type: ProductDataOverviewDto })
  async overview(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string) {
    await this.access.assertRead(ctx, companyId);
    return this.data.overview(ctx, companyId);
  }

  @Get('products/:productId')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'One product: *Isian*\'s values, the version in force and every version' })
  @ApiResponse({ status: 200, type: ProductDataDetailDto })
  async detail(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string) {
    await this.access.assertRead(ctx, companyId);
    return this.data.detail(ctx, companyId, productId);
  }

  @Patch('products/:productId/rules')
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: '*Isian*: the product\'s proposal setup',
    description: 'The catalogue\'s own fields and rules, checked as the catalogue checks them, pinned to `expectedVersion`, '
      + 'audited `product_rules.updated` with before and after. They apply while no premium table is in force, and each '
      + 'new version starts from them.',
  })
  @ApiResponse({ status: 200, type: ProductDataDetailDto })
  async saveRules(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string,
    @Body() body: ProductRulesDto,
  ) {
    await this.access.assertManage(ctx, companyId);
    await this.rules.apply(ctx, companyId, productId, body as never);
    return this.data.detail(ctx, companyId, productId);
  }

  @Get('products/:productId/rate-tables/template')
  @RequirePermission('product_data:read')
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiOperation({ summary: 'The product\'s premium table template: *Data* with its columns, and *Ketentuan*' })
  @ApiResponse({ status: 200, description: 'The template, as `.xlsx` or `.csv`.' })
  async template(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string,
    @Query() query: RateTableTemplateQueryDto,
  ) {
    await this.access.assertRead(ctx, companyId);
    const file = await this.tables.template(companyId, productId, query.format ?? 'xlsx');
    return new StreamableFile(file.bytes, { type: file.contentType, disposition: `attachment; filename="${file.fileName}"` });
  }

  @Post('products/:productId/rate-tables')
  @RequirePermission('product_data:manage')
  @UseInterceptors(RateTableUpload)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object', required: ['file', 'effectiveFrom'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Excel (.xlsx) or CSV, at most 2 MiB and 10,000 rows.' },
        effectiveFrom: { type: 'string', example: '2026-12-01' },
        effectiveTo: { type: 'string', example: '2027-11-30' },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload a premium table as a draft (step 1)',
    description: 'The file is read and kept with the draft; the columns are suggested. A PDF goes through *Unggah file*. '
      + '`413 ASSET_TOO_LARGE` over 2 MiB; `422 UPLOAD_MALFORMED_CSV` for a file that is neither a workbook nor text, '
      + 'or has no header, or more than 10,000 rows; `400` for a missing file or a bad date.',
  })
  @ApiResponse({ status: 201, type: RateTableViewDto })
  async upload(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string,
    @Body() body: UploadRateTableDto, @UploadedFile() file?: FileUpload,
  ) {
    await this.access.assertManage(ctx, companyId);
    return this.tables.upload(ctx, companyId, productId, file, body);
  }

  @Post('products/:productId/try')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:read')
  @ApiOperation({
    summary: '*Uji coba*: the agent\'s card, calculated, nothing stored',
    description: 'The same functions as the item\'s `PATCH` and its calculation; answers the item and the PDF box.',
  })
  @ApiResponse({ status: 200, type: ProductTryDto })
  async tryIt(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string,
    @Body() body: TryProductDto,
  ) {
    await this.access.assertRead(ctx, companyId);
    return this.data.tryIt(companyId, productId, body as unknown as TryInput);
  }

  @Get('rate-tables/:rateTableId')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'One premium table version, with its draft\'s file' })
  @ApiResponse({ status: 200, type: RateTableViewDto })
  async readTable(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string) {
    await this.access.assertRead(ctx, companyId);
    return this.tables.read(companyId, id);
  }

  @Patch('rate-tables/:rateTableId')
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'A draft\'s columns, dates, rules or factors (steps 2 and 3)',
    description: '`422 RATE_TABLE_ROWS_INVALID` with every unreadable cell; `409 RATE_TABLE_NOT_EDITABLE` for a version '
      + 'already activated.',
  })
  @ApiResponse({ status: 200, type: RateTableViewDto })
  async updateTable(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string,
    @Body() body: UpdateRateTableDto,
  ) {
    await this.access.assertManage(ctx, companyId);
    return this.tables.update(ctx, companyId, id, body);
  }

  @Put('rate-tables/:rateTableId/tests')
  @RequirePermission('product_data:manage')
  @ApiOperation({ summary: '*Uji 3 contoh*: three profiles from the official illustration, each calculated beside it' })
  @ApiResponse({ status: 200, type: RateTableViewDto })
  async tests(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string, @Body() body: RateTestsDto,
  ) {
    await this.access.assertManage(ctx, companyId);
    return this.tables.setTests(ctx, companyId, id, body.cases);
  }

  @Post('rate-tables/:rateTableId/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'Activate a draft',
    description: '`422 RATE_TABLE_NOT_READY`, `details.reason`: `unmapped`, `no_rows`, `rules`, `tests` (the three '
      + 'profiles not all within Rp1 and no `overrideReason`).',
  })
  @ApiResponse({ status: 200, type: RateTableViewDto })
  async activate(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string,
    @Body() body: ActivateRateTableDto,
  ) {
    await this.access.assertManage(ctx, companyId);
    return this.tables.activate(ctx, companyId, id, body.overrideReason ?? null);
  }

  @Post('rate-tables/:rateTableId/turn-off')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({ summary: 'Turn a version off: the product goes back to the version before, or to typing' })
  @ApiResponse({ status: 200, type: RateTableViewDto })
  async turnOff(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string) {
    await this.access.assertManage(ctx, companyId);
    return this.tables.turnOff(ctx, companyId, id);
  }

  @Delete('rate-tables/:rateTableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('product_data:manage')
  @ApiOperation({ summary: 'Delete a version no proposal used', description: '`409 RATE_TABLE_IN_USE` once one did.' })
  @ApiResponse({ status: 204, description: 'Deleted (soft).' })
  async remove(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('rateTableId') id: string) {
    await this.access.assertManage(ctx, companyId);
    await this.tables.remove(ctx, companyId, id);
  }
}
