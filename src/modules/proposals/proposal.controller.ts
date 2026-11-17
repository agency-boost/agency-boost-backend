import {
  Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  AddProposalItemDto, CreateProposalDto, ListProposalsQueryDto, PinnedDto, PinnedQueryDto, ProposalCatalogQueryDto,
  UpdateProposalDto, UpdateProposalItemDto,
} from './proposal.dto';
import {
  ProposalCatalogDto, ProposalDuplicatedDto, ProposalPageDto, ProposalPatchedDto, ProposalResponseDto,
} from './proposal.response.dto';
import { ProposalPdfService } from './proposal-pdf.service';
import { ProposalService } from './proposal.service';

/** Another member's, another KPM's, a deleted or an unknown proposal: one answer for all four. */
const NOT_YOURS =
  '`PROPOSAL_NOT_FOUND` — not a proposal of yours: another member’s (a leader’s downline’s included, for every role), '
  + 'another office’s, a deleted one, or nobody’s. The four are indistinguishable on purpose.';

const STALE = '`VERSION_CONFLICT` — the proposal changed since `expectedVersion` (another device): read it again. Nothing was written.';

const PINNED_WRITE =
  'Pinned: `expectedVersion` is the version you read. **Any write to a *Selesai* proposal makes it a *Draf* again**, until the '
  + 'next *Simpan PDF*. A view-only session is refused every write (`403 IMPERSONATION_READ_ONLY`).';

/**
 * **The simple proposal** (P19.7-T2; ADR-0221; `functional/proposal.md`): *Riwayat*, the draft created at step 1's
 * *Lanjut*, every change saved, the catalogue step 2 adds from, *Simpan PDF*'s first half, the duplicate and the soft
 * delete. **Every route is the caller's own**, under `proposal:*` (`own`): nobody else reads a proposal, and nothing is
 * public or sent.
 *
 * **`GET /proposals/catalog` is declared above `GET /proposals/:proposalId`**, or Nest would read *catalog* as an id.
 * The PDF (`GET /proposals/:proposalId/pdf`, `proposal:download`; P19.7-T3, ADR-0222) is the answer to a signed-in
 * request and nothing else: no token, no public link, nothing kept.
 */
@ApiTags('proposals')
@ApiBearerAuth()
@Controller('proposals')
export class ProposalController {
  constructor(
    private readonly proposals: ProposalService,
    private readonly files: ProposalPdfService,
  ) {}

  @Get()
  @RequirePermission('proposal:read')
  @ApiOperation({
    summary: 'Your proposals (*Riwayat*)',
    description:
      'Your own live proposals, newest change first: each row’s client, date, products with their plan, status and '
      + 'totals per currency and *Cara bayar*. `leadId` narrows to one lead — the lead sheet’s *Proposal* section reads '
      + '`?leadId=…`, one row per proposal, drafts included (ADR-0257). **`status=done` orders by the last *Simpan PDF* '
      + '(`doneAt`)** instead. A deleted lead’s proposals stay, under the client’s name, with `leadDeleted`.',
  })
  @ApiResponse({ status: 200, type: ProposalPageDto })
  async list(@Ctx() ctx: RequestContext, @Query() query: ListProposalsQueryDto) {
    return this.proposals.list(ctx, query);
  }

  @Get('catalog')
  @RequirePermission('proposal:read')
  @ApiOperation({
    summary: 'The products step 2 may add',
    description:
      'Your KPM’s shelf, base products on sale — conventional and syariah side by side, a syariah product by its own '
      + 'name (no channel since P19.14) — each with its fields, pay terms, *Cara bayar*, calculation type and entry ages, '
      + 'its plans and *Tanya-jawab* as your KPM approved them, the riders that *can be added* to it (never products of '
      + 'their own here), and **`outOfAge`** for the client’s `age`: listed and greyed, never hidden, and never added. '
      + 'Nothing to offer is an empty list, never an error.',
  })
  @ApiResponse({ status: 200, type: ProposalCatalogDto })
  async catalog(@Ctx() ctx: RequestContext, @Query() query: ProposalCatalogQueryDto) {
    return this.proposals.catalog(ctx, query.age ?? null);
  }

  @Get(':proposalId')
  @RequirePermission('proposal:read')
  @ApiOperation({ summary: 'One of your proposals', description: 'Its items with their snapshots, `totalPaid` and `totals`.' })
  @ApiResponse({ status: 200, type: ProposalResponseDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  async read(@Ctx() ctx: RequestContext, @Param('proposalId') id: string) {
    return this.proposals.read(ctx, id);
  }

  @Get(':proposalId/pdf')
  @RequirePermission('proposal:download')
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'The proposal’s PDF (the result, *Simpan PDF*, *Unduh lagi*)',
    description:
      'One A4 page for one product, two for more, built now from the stored proposal with the KPM’s branding as it '
      + 'shows today, and kept nowhere (ADR-0222, ADR-0256). A *Draf* is built too; nothing about the proposal changes — '
      + '*Selesai* is `POST …/done`. `Content-Disposition: attachment` names it `Proposal-{Nama klien}-{tanggal}.pdf`. '
      + '**A view-only session is refused** (`403 PERM_DENIED`, `details.permission: "proposal:download"`): it opens a '
      + 'proposal and cannot take it away (Acc. 22).',
  })
  // The 200 is the file alone (`application/pdf`, `response-map.ts`); the refusals are the envelope, as everywhere.
  @ApiResponse({ status: 200, description: 'The file.' })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  async pdf(@Ctx() ctx: RequestContext, @Param('proposalId') id: string) {
    const file = await this.files.pdf(ctx, id);
    return new StreamableFile(file.bytes, { type: 'application/pdf', disposition: file.disposition, length: file.bytes.length });
  }

  @Post()
  @RequirePermission('proposal:create')
  @ApiOperation({
    summary: 'Start a proposal (step 1’s *Lanjut*)',
    description:
      'A *Draf* for one of your own live **Sales** leads: the client’s name copied from the lead, **the age at the next '
      + 'birthday, the gender and the optional details from `client` — the proposal’s, never written to the lead**. '
      + 'Without an age or a gender, `400`, `details.field: "client.age"` or `"client.gender"`; an age outside 1–100 '
      + '`422 LEAD_AGE_OUT_OF_RANGE`. **Where you already have a draft on that lead with no product chosen, that draft '
      + 'is answered instead**, its client taken from this write, so no lead collects empty drafts; a draft with a product '
      + 'is never reused. Another member’s lead or another office’s is `404 NOT_FOUND`; a Recruit lead or one with no type '
      + '`400`, `details.field: "leadId"`.',
  })
  @ApiResponse({ status: 201, type: ProposalResponseDto, description: 'The new draft, or the lead’s empty one reused.' })
  @ApiResponse({
    status: 404,
    description: '`NOT_FOUND` — not one of your live leads: somebody else’s, or one in another office. The two are '
      + 'indistinguishable on purpose.',
    type: ApiErrorEnvelope,
  })
  async create(@Ctx() ctx: RequestContext, @Body() body: CreateProposalDto) {
    return this.proposals.create(ctx, body.leadId, body.client ?? {});
  }

  @Patch(':proposalId')
  @RequirePermission('proposal:update')
  @ApiOperation({
    summary: 'Change *Tampilkan total*, or step 1’s lead and client',
    description:
      '*Tampilkan total*, and step 1: a `leadId` takes that lead’s name; `client` lays the age, gender and details over '
      + 'what is stored — never onto the lead. **A change of the client’s age removes the products whose entry ages it '
      + 'leaves**, in the same write, and answers their item ids (`removedItemIds`); each client-insured pay term is held '
      + 'to the new age. ' + PINNED_WRITE,
  })
  @ApiResponse({ status: 200, type: ProposalPatchedDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  async update(@Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Body() body: UpdateProposalDto) {
    return this.proposals.update(ctx, id, body);
  }

  @Post(':proposalId/items')
  @RequirePermission('proposal:update')
  @ApiOperation({
    summary: 'Add a product',
    description:
      'With a copy of the product as it is now (its fields, pay terms, *Cara bayar* and labels, never refreshed), every '
      + 'choice field preselected, the derived one worked out, the product’s own *Tertanggung*, its default pay term the '
      + 'age allows and *Cara bayar* *Bulanan* where offered. A product already in, or a sixth, is `400`. A product the '
      + 'catalogue does not offer is `422 PROPOSAL_PRODUCT_WITHDRAWN`, `details.reason`: `withdrawn`, `closed`, `rider`, '
      + '`not_on_shelf` or `age` (the client outside its entry ages). ' + PINNED_WRITE,
  })
  @ApiResponse({ status: 201, type: ProposalResponseDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  @ApiResponse({ status: 422, description: '`PROPOSAL_PRODUCT_WITHDRAWN` — not offered; `details.reason` says why.', type: ApiErrorEnvelope })
  async addItem(@Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Body() body: AddProposalItemDto) {
    return this.proposals.addItem(ctx, id, body.expectedVersion, body.productId);
  }

  @Patch(':proposalId/items/:itemId')
  @RequirePermission('proposal:update')
  @ApiOperation({
    summary: 'Change a product’s *Tertanggung*, fields, pay term, *Cara bayar*, sum assured or premium',
    description:
      'Each checked against the item’s own copy of the product: a value outside its options or bounds, a fixed or derived '
      + 'field, an unknown key or item, a pay term the insured’s age does not allow, a *Cara bayar* the product does not '
      + 'offer, *Merokok?* on a product not smoker-rated, or a sum assured on a product without one is `400`; an insured’s '
      + 'age outside 1–100 is `422 LEAD_AGE_OUT_OF_RANGE`. A change of the insured’s age moves a pay term it no longer '
      + 'allows to the longest it does; a change of *Cara bayar* empties this item’s premium. ' + PINNED_WRITE,
  })
  @ApiResponse({ status: 200, type: ProposalResponseDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  @ApiResponse({ status: 422, description: '`LEAD_AGE_OUT_OF_RANGE` — the insured’s age, `details: { min, max }`.', type: ApiErrorEnvelope })
  async updateItem(
    @Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Param('itemId') itemId: string, @Body() body: UpdateProposalItemDto,
  ) {
    const { expectedVersion, ...patch } = body;
    return this.proposals.updateItem(ctx, id, itemId, expectedVersion, patch as never);
  }

  @Delete(':proposalId/items/:itemId')
  @RequirePermission('proposal:update')
  @ApiOperation({ summary: 'Remove a product', description: PINNED_WRITE })
  @ApiResponse({ status: 200, type: ProposalResponseDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  async removeItem(
    @Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Param('itemId') itemId: string, @Query() query: PinnedQueryDto,
  ) {
    return this.proposals.removeItem(ctx, id, itemId, query.expectedVersion);
  }

  @Post(':proposalId/done')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proposal:update')
  @ApiOperation({
    summary: '*Simpan PDF*: mark it *Selesai*',
    description:
      'Needs a complete proposal — a product at least, each premium above zero, a name and an age for anyone insured but '
      + 'the client, a value for every choice and derived field, a pay term where the product has any — else `422 '
      + 'PROPOSAL_INCOMPLETE`, `details.items: [{ itemId, missing }]`; '
      + 'and every product still offered, else `422 PROPOSAL_PRODUCT_WITHDRAWN`, `details.itemIds`. The first time, the '
      + 'lead’s *Riwayat* gains *"Proposal dibuat · …"* — derived, nothing is written to the lead. Step 3’s button.',
  })
  @ApiResponse({ status: 200, type: ProposalResponseDto })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  @ApiResponse({ status: 422, description: '`PROPOSAL_INCOMPLETE` or `PROPOSAL_PRODUCT_WITHDRAWN`.', type: ApiErrorEnvelope })
  async done(@Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Body() body: PinnedDto) {
    return this.proposals.done(ctx, id, body.expectedVersion);
  }

  @Post(':proposalId/duplicate')
  @RequirePermission('proposal:create')
  @ApiOperation({
    summary: 'Duplicate a proposal',
    description:
      'A new *Draf* for the same lead: the lead’s name, the client’s age moved up by the years since it was entered, the '
      + 'products copied with their values, and any product no longer offered left out (`droppedProductIds`). A deleted '
      + 'lead’s proposal is `404 NOT_FOUND`.',
  })
  @ApiResponse({ status: 201, type: ProposalDuplicatedDto })
  @ApiResponse({ status: 404, description: `${NOT_YOURS} Or \`NOT_FOUND\` — its lead was deleted.`, type: ApiErrorEnvelope })
  async duplicate(@Ctx() ctx: RequestContext, @Param('proposalId') id: string) {
    return this.proposals.duplicate(ctx, id);
  }

  @Delete(':proposalId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('proposal:delete')
  @ApiOperation({
    summary: 'Delete a proposal',
    description:
      '**Soft.** It leaves *Riwayat*, the lead’s pill and its *Proposal* section; the lead’s *"Proposal dibuat"* note stays, '
      + 'without its link. Pinned by `expectedVersion`.',
  })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 404, description: NOT_YOURS, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  async remove(@Ctx() ctx: RequestContext, @Param('proposalId') id: string, @Query() query: PinnedQueryDto) {
    await this.proposals.remove(ctx, id, query.expectedVersion);
  }
}
