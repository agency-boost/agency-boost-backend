import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { BillingKpmListDto, BillingKpmRowDto } from './billing.response.dto';
import { BillingKpmsQueryDto, ConfirmPackageDto, OfferPdfDto } from './billing.dto';
import { BillingService } from './billing.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const INPUTS_400 = '`VALIDATION_FAILED` — `details.field` names it: `leaders` (1 to 10.000), `agents`, `plan`, '
  + '`price.rateMinor` (whole rupiah, Rp 0 to Rp 100.000.000), `price.totalMinor`, `bulk.percent` (a whole 0 to 100), '
  + '`bulk.amountMinor` (up to the total), a date that is no day, an end before the start, a note over 500 characters.';

/**
 * **Langganan & akses per KPM** (P19.23-T5 AC-2, AC-4; ADR-0279; `functional/billing.md`, the Data contract): the list
 * of KPMs on *Langganan per KPM*, *Konfirmasi paket* from a KPM's *Atur*, and *Buat PDF*. Apart from
 * `BillingController`, whose price read reads no collection and has no constructor, so its spec still proves that.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class KpmBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing/kpms')
  @RequirePermission('billing:read_prices')
  @ApiOperation({
    summary: 'Langganan per KPM: every KPM with its subscription, the summary and the Total row',
    description:
      'One row per live, unarchived KPM (ADR-0279 §6): its company, *Leader dipakai* against the limit (test accounts '
      + 'never counted), *Harga / leader* and its tier, *Per bulan*, *Tagihan per periode*, *Berlaku hingga*, the one '
      + 'pill it needs (`attention`: `suspended`, `ended`, `over`, `trial`, `ending_soon`) and whether it is on *Perlu '
      + 'tindakan*; its Owner’s name and WhatsApp number for *Kirim penawaran*. `filter=needs_action` narrows the rows and '
      + 'the *Total* row; the navy summary always reads every KPM. Not paginated. The Super Admin’s alone; refused in a '
      + 'support session.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `filter` other than `all` or `needs_action`, or a parameter of any '
    + 'other name.'))
  @ApiResponse({ status: 200, type: BillingKpmListDto })
  async list(@Ctx() ctx: RequestContext, @Query() query: BillingKpmsQueryDto) {
    return this.billing.list(ctx, query.filter ?? 'all');
  }

  @Put('billing/kpms/:kpmId/subscription')
  @RequirePermission('kpm:update_subscription')
  @ApiOperation({
    summary: 'Konfirmasi paket: set a KPM’s subscription from the calculator',
    description:
      '*Pakai untuk KPM* / *Konfirmasi paket* (ADR-0279 §3): the calculator’s inputs — **no figure**: the server prices '
      + 'them through the one function the browser’s calculator is pinned to by a shared fixture — written as the KPM’s '
      + 'subscription: its dates, the price per leader, the leader limit (the leaders priced), the plan, the period’s '
      + 'total, the bulk discount, the agents and the note. The trial ends. A KPM the daily run suspended for a lapsed '
      + 'subscription is reactivated when the new period is not itself past its grace. Audited as '
      + '`kpm.subscription_updated` with the subscription before and after (and `kpm.active` on a reactivation). '
      + 'Answers the KPM’s row as the list reads it.',
  })
  @ApiResponse(refusal(400, INPUTS_400))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live, unarchived KPM with this id: indistinguishable from another office’s.'))
  @ApiResponse({ status: 200, type: BillingKpmRowDto })
  async confirmPackage(@Ctx() ctx: RequestContext, @Param('kpmId') kpmId: string, @Body() dto: ConfirmPackageDto) {
    return this.billing.confirmPackage(ctx, kpmId, dto);
  }

  @Post('billing/offer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('billing:send_quote')
  @ApiOperation({
    summary: 'Buat PDF: the offer as a one-page PDF',
    description:
      '*Buat PDF* (ADR-0279 §7): the calculator’s inputs and the KPM it is for — an existing one by `kpmId`, whose name '
      + 'and company are read here, or a new one by `kpmName` as typed — priced on the server and drawn in Bahasa '
      + 'Indonesia: the period, the dates, the leaders, the price, *Harga normal*, the breakdown, the *Total*, the '
      + 'per-day figures, *Hemat*, *Balik modal* and the note; the footer carries *Nomor WhatsApp pengirim* when one is '
      + 'set. Built in memory and never kept; nothing is audited. `Content-Disposition: attachment` names it '
      + '`Penawaran-{KPM}-{tanggal}.pdf`.',
  })
  @ApiResponse(refusal(400, `${INPUTS_400} Neither a \`kpmId\` nor a \`kpmName\` (\`details.field\`: \`kpmName\`).`))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — a `kpmId` that is no live, unarchived KPM: indistinguishable from another '
    + 'office’s.'))
  @ApiResponse({ status: 200, description: 'The PDF itself (`application/pdf`).' })
  async offerPdf(@Ctx() ctx: RequestContext, @Body() dto: OfferPdfDto) {
    const file = await this.billing.offerPdf(ctx, dto);
    return new StreamableFile(file.bytes, { type: 'application/pdf', disposition: file.disposition, length: file.bytes.length });
  }
}
