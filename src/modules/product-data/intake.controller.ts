import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { INTAKE } from '@/domain/constants';
import type { UploadedFile } from './intake-files';
import { IntakeUploadInterceptor } from './intake-upload.interceptor';
import { AnswerIntakeQuestionDto } from './intake.dto';
import {
  IntakeDetailDto, IntakeFileLinkDto, IntakeItemViewDto, IntakeListDto, IntakeViewDto,
} from './intake.response.dto';
import { IntakeService } from './intake.service';

const FILES_BODY = {
  schema: {
    type: 'object',
    required: ['files'],
    properties: {
      files: {
        type: 'array', items: { type: 'string', format: 'binary' },
        description: `Up to ${INTAKE.FILES_MAX} files of up to ${INTAKE.FILE_MAX_BYTES / 1024 / 1024} MiB: Excel, CSV, PDF, PNG, JPEG, WebP, Word (.docx) or ZIP.`,
      },
    },
  },
};

/**
 * ***Unggah file*** (P19.15-T3; ADR-0259): upload anything, see *Yang kami pahami*, answer the questions, confirm or
 * reject each card. Under `/product-data`, not `/admin`, so a holder of *Kelola data produk* reaches it for the
 * companies ticked for them; the permission says what kind of person, `ProductDataAccess` which company.
 */
@ApiTags('product data (Unggah file)')
@ApiBearerAuth()
@Controller('product-data')
export class IntakeController {
  constructor(private readonly intakes: IntakeService) {}

  @Get('intakes')
  @RequirePermission('product_data:read')
  @ApiOperation({
    summary: 'Every recent upload (Super Admin, *Perusahaan*)',
    description: 'Newest first, at most 30, every company’s and those whose company the files must say. Anybody but a Super Admin as themselves: `404`.',
  })
  @ApiResponse({ status: 200, type: IntakeListDto })
  async listAll(@Ctx() ctx: RequestContext) {
    return this.intakes.list(ctx, null);
  }

  @Post('intakes')
  @RequirePermission('product_data:manage')
  @UseInterceptors(IntakeUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILES_BODY)
  @ApiOperation({
    summary: 'Upload files for any company (Super Admin, *Perusahaan*)',
    description: 'Answers at once with the intake `reading`; poll `GET /product-data/intakes/:intakeId`. The files must say '
      + 'the company, or a card asks. `AI_READING_OFF` (503) without `ANTHROPIC_API_KEY`; `ASSET_TYPE_NOT_ALLOWED` (415) '
      + 'naming a file not read, or a ZIP in a ZIP; `ASSET_TOO_LARGE` (413); `VALIDATION_FAILED` (400) for no file or too many.',
  })
  @ApiResponse({ status: 201, type: IntakeViewDto })
  async uploadAny(@Ctx() ctx: RequestContext, @UploadedFiles() files?: UploadedFile[]) {
    return this.intakes.upload(ctx, null, files ?? []);
  }

  @Get('companies/:companyId/intakes')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'One company’s recent uploads', description: 'Newest first, and whether reading is switched on.' })
  @ApiResponse({ status: 200, type: IntakeListDto })
  async list(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string) {
    return this.intakes.list(ctx, companyId);
  }

  @Post('companies/:companyId/intakes')
  @RequirePermission('product_data:manage')
  @UseInterceptors(IntakeUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILES_BODY)
  @ApiOperation({
    summary: 'Upload files for one company (*Unggah file* on the Proposal tab)',
    description: 'As `POST /product-data/intakes`, the company known. A reader who may read the company but not manage it: `403 PERM_DENIED`.',
  })
  @ApiResponse({ status: 201, type: IntakeViewDto })
  async upload(@Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @UploadedFiles() files?: UploadedFile[]) {
    return this.intakes.upload(ctx, companyId, files ?? []);
  }

  @Get('intakes/:intakeId')
  @RequirePermission('product_data:read')
  @ApiOperation({
    summary: 'One upload with *Yang kami pahami*',
    description: 'Its files, and one card per product: old → new with each value’s source, and the question cards. A '
      + 'reading still unfinished 15 minutes after it started reads `failed` (`stale`).',
  })
  @ApiResponse({ status: 200, type: IntakeDetailDto })
  async read(@Ctx() ctx: RequestContext, @Param('intakeId') intakeId: string) {
    return this.intakes.read(ctx, intakeId);
  }

  @Get('intakes/:intakeId/files/:index')
  @RequirePermission('product_data:read')
  @ApiOperation({ summary: 'A link to an original file', description: 'Ten minutes. `404` when the file was not kept.' })
  @ApiResponse({ status: 200, type: IntakeFileLinkDto })
  async file(@Ctx() ctx: RequestContext, @Param('intakeId') intakeId: string, @Param('index', ParseIntPipe) index: number) {
    return this.intakes.fileLink(ctx, intakeId, index);
  }

  @Post('intakes/:intakeId/items/:itemId/answers')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'Answer a question card',
    description: 'One of its choices, a day, a number exactly as the file shows it, or a short text. *Abaikan* and a '
      + 'percentage not approved reject the card. `VALIDATION_FAILED` (400); `INTAKE_ITEM_DECIDED` (409).',
  })
  @ApiResponse({ status: 200, type: IntakeItemViewDto })
  async answer(
    @Ctx() ctx: RequestContext, @Param('intakeId') intakeId: string, @Param('itemId') itemId: string, @Body() dto: AnswerIntakeQuestionDto,
  ) {
    return this.intakes.answer(ctx, intakeId, itemId, dto);
  }

  @Post('intakes/:intakeId/items/:itemId/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({
    summary: 'Confirm a card: apply it through its flow',
    description: 'A premium table becomes a draft version (then its gaps, three test profiles and activation, in *Tabel '
      + 'premi*); rules go through the premium table’s rules; a catalogue change through the catalogue; an illustration '
      + 'is condensed in *Ilustrasi*. `INTAKE_QUESTIONS_OPEN` (409); `INTAKE_APPLY_REFUSED` (409); `INTAKE_ITEM_DECIDED` (409).',
  })
  @ApiResponse({ status: 200, type: IntakeItemViewDto })
  async confirm(@Ctx() ctx: RequestContext, @Param('intakeId') intakeId: string, @Param('itemId') itemId: string) {
    return this.intakes.confirm(ctx, intakeId, itemId);
  }

  @Post('intakes/:intakeId/items/:itemId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('product_data:manage')
  @ApiOperation({ summary: 'Reject a card', description: 'Nothing is applied. `INTAKE_ITEM_DECIDED` (409).' })
  @ApiResponse({ status: 200, type: IntakeItemViewDto })
  async reject(@Ctx() ctx: RequestContext, @Param('intakeId') intakeId: string, @Param('itemId') itemId: string) {
    return this.intakes.reject(ctx, intakeId, itemId);
  }
}
