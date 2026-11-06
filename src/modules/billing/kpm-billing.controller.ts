import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { BillingKpmRowDto, QuoteSentDto } from './billing.response.dto';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { BillingKpmsQueryDto, SendQuoteDto } from './billing.dto';
import { BillingService } from './billing.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **Billing per KPM** (ADR-0211; P19.4-T3 AC-10; `functional/billing.md`, the Data contract): the list of KPMs on
 * `/admin/billing`, and *Kirim penawaran* from a KPM's *Billing* tab. Apart from `BillingController`, whose price read
 * reads no collection and has no constructor, so its spec still proves that.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class KpmBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('billing/kpms')
  @RequirePermission('billing:read_prices')
  @ApiOperation({
    summary: 'Every KPM with its leaders, tier, plan and renewal',
    description:
      'One row per live KPM (ADR-0211 §3): its code and branch, its company, *Leader* (`leadersUsed`, ADR-0113), '
      + '*Tingkat* (the price tier those leaders fall in), *Paket* (`six_months`, `annual` or `null`), *Perpanjangan* '
      + '(the subscription\'s end date) and *Status* (`active`, `ended`, `ended_kept_active`, `none`) — counts and codes, '
      + 'no member named. `companyId` narrows it; `sort` orders it by a column (`kpm` by default) and `dir` the way. '
      + 'Not paginated. The Super Admin\'s alone; refused in a support session.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — a `companyId` that is not an id, a `sort` or `dir` it does not know, '
    + 'or a parameter of any other name.'))
  @ApiResponse({ status: 200, type: BillingKpmRowDto, isArray: true })
  async list(@Ctx() ctx: RequestContext, @Query() query: BillingKpmsQueryDto) {
    return this.billing.list(ctx, query);
  }

  @Post('tenants/:kpmId/quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('billing:send_quote')
  @ApiOperation({
    summary: 'Send a KPM\'s quote to its Owner',
    description:
      '*Kirim penawaran* (ADR-0211 §5): the calculator\'s inputs and the dialog\'s names — **no figure**: the server '
      + 'prices the quote from the tier table, the one function the browser\'s calculator is pinned to by a shared '
      + 'fixture. Sent to the KPM\'s Owner alone, by email to their verified address with the printable quote\'s content '
      + 'and in the app (`billing.quote_received`); the Admins are not told. Audited as `billing.quote_sent` in the '
      + 'platform\'s log and the KPM\'s, with the recipient, the leaders, the plan, the rate, the total and the discount. '
      + 'Nothing is stored as a quote. Answers who received it and the server\'s figures.',
  })
  @ApiResponse(refusal(400, '`VALIDATION_FAILED` — `details.field` names it: `leaders` below 1, a `plan` it does not '
    + 'know, a percent above 100 or an amount above the plan\'s rate, a date that is no day, an end before the start, an '
    + 'empty PIC or sender.'))
  @ApiResponse(refusal(403, '`PERM_DENIED` — every tenant role; a support session, read-only by its method.'))
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM with this id: indistinguishable from another office’s.'))
  @ApiResponse(refusal(409, '`BILLING_QUOTE_NO_OWNER` — the KPM has no Owner, or the Owner\'s address is not verified '
    + '(`details.reason`: `no_owner` | `unverified`). Print the quote instead. Nothing is sent or recorded.'))
  @ApiResponse({ status: 200, type: QuoteSentDto })
  async sendQuote(@Ctx() ctx: RequestContext, @Param('kpmId') kpmId: string, @Body() dto: SendQuoteDto) {
    return this.billing.sendQuote(ctx, kpmId, dto);
  }
}
