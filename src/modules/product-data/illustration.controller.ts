import {
  Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import type { FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { IllustrationUploadInterceptor } from './intake-upload.interceptor';
import { UpdateIllustrationDto, UploadIllustrationDto } from './intake.dto';
import {
  BoxPreviewDto, IllustrationListDto, IllustrationViewDto, IntakeFileLinkDto,
} from './intake.response.dto';
import { IllustrationService, type BlockInput } from './illustration.service';

/**
 * **The *Ilustrasi* tab** (P19.15-T2; ADR-0259 §8): the official illustration uploaded, condensed into the PDF's detail
 * blocks, every amount a formula checked against the illustration's own numbers, edited, previewed as agents print it,
 * and published for new proposals.
 */
@ApiTags('product data (Ilustrasi)')
@ApiBearerAuth()
@Controller('product-data/companies/:companyId')
export class IllustrationController {
  constructor(private readonly illustrations: IllustrationService) {}

  @Get('products/:productId/illustrations')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'A product’s illustrations', description: 'Newest first, and whether reading is switched on.' })
  @ApiResponse({ status: 200, type: IllustrationListDto })
  async list(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string) {
    return this.illustrations.list(ctx, companyId, productId);
  }

  @Post('products/:productId/illustrations')
  @RequirePermission('product_data:manage')
  @UseInterceptors(IllustrationUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'illustrationDate'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'The official illustration, a PDF of at most 20 MiB.' },
        illustrationDate: { type: 'string', example: '2026-11-01' },
        plan: { type: 'string', nullable: true },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload an official illustration',
    description: 'Answers at once, `reading`; poll the illustration. `AI_READING_OFF` (503); `ASSET_TYPE_NOT_ALLOWED` '
      + '(415) for anything but a PDF; `VALIDATION_FAILED` (400) for a date that is no day or after today.',
  })
  @ApiResponse({ status: 201, type: IllustrationViewDto })
  async upload(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('productId') productId: string,
    @Body() dto: UploadIllustrationDto, @UploadedFile() file?: FileUpload,
  ) {
    return this.illustrations.upload(ctx, companyId, productId, file, dto);
  }

  @Get('illustrations/:illustrationId')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'One illustration: its blocks, each row’s page and check' })
  @ApiResponse({ status: 200, type: IllustrationViewDto })
  async read(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string) {
    return this.illustrations.read(ctx, companyId, id);
  }

  @Patch('illustrations/:illustrationId')
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'Edit the blocks’ wording and formulas',
    description: 'Every formula checked again against the numbers its row was read with. `ILLUSTRATION_NOT_DRAFT` (409); `VALIDATION_FAILED` (400).',
  })
  @ApiResponse({ status: 200, type: IllustrationViewDto })
  async update(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string, @Body() dto: UpdateIllustrationDto,
  ) {
    return this.illustrations.update(ctx, companyId, id, { blocks: dto.blocks as BlockInput[] });
  }

  @Get('illustrations/:illustrationId/preview')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'The product’s PDF box: every row, and what two and three-or-four products keep' })
  @ApiResponse({ status: 200, type: BoxPreviewDto })
  async preview(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string) {
    return this.illustrations.preview(ctx, companyId, id);
  }

  @Get('illustrations/:illustrationId/preview.pdf')
  @RequirePermission('product_data:read')
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'The box as agents print it: a sample proposal’s file, built by the proposal’s own builder' })
  // The 200 is the file alone (`application/pdf`, `response-map.ts`); the refusals are the envelope, as everywhere.
  @ApiResponse({ status: 200, description: 'The file.' })
  async previewPdf(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string) {
    const bytes = await this.illustrations.previewPdf(ctx, companyId, id);
    return new StreamableFile(bytes, { type: 'application/pdf', disposition: 'inline; filename="contoh-proposal.pdf"', length: bytes.length });
  }

  @Get('illustrations/:illustrationId/file')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'A link to the original PDF', description: 'Ten minutes. `404` when it was not kept.' })
  @ApiResponse({ status: 200, type: IntakeFileLinkDto })
  async file(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string) {
    return this.illustrations.fileLink(ctx, companyId, id);
  }

  @Post('illustrations/:illustrationId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'Publish: the blocks become the product’s PDF detail for new proposals',
    description: 'Saved proposals keep what they printed. `ILLUSTRATION_FORMULA_MISMATCH` (409) while a formula does not match; `ILLUSTRATION_NOT_DRAFT` (409).',
  })
  @ApiResponse({ status: 200, type: IllustrationViewDto })
  async publish(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Param('illustrationId') id: string) {
    return this.illustrations.publish(ctx, companyId, id);
  }
}
