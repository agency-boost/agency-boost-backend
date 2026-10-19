import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '@/common/auth/auth.decorators';
import {
  BILLING_ANNUAL_DISCOUNT_PCT, BILLING_CURRENCY, BILLING_PRICE_TIERS,
} from '@/domain/constants';
import { BillingPricesDto } from './billing.response.dto';

/**
 * The quote tool's one route (ADR-0111, `functional/billing.md`).
 *
 * **It stores nothing and reads nothing stored.** The price table is a domain constant (§3), and the
 * figures, the dialog and the quote all live in the browser, whose print is the PDF (§2, §7). So the
 * controller has no constructor: no repository, no model, no audit writer. That is the structural proof
 * that the route reads no collection and writes no audit row, and the int spec builds it with no
 * providers at all, so a dependency added later fails there before it ships.
 *
 * **Its own controller, not another `AdminController` route.** Billing has nothing to do with tenant
 * management, which is all `AdminController` holds (ADR-0011); the path still sits under `/admin`, the
 * console's own prefix.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/billing')
export class BillingController {
  @Get('prices')
  @RequirePermission('billing:read_prices')
  @ApiOperation({
    summary: 'The subscription price table, for the quote tool',
    description:
      'Every tier by its stable code: the leader-count bounds (the last open), the standard, ' +
      'six-month and annual rates per leader per month in IDR minor units, and whether the tier is ' +
      'shown publicly as “Custom pricing”; and the annual rate’s discount off the ' +
      'six-month rate. A constant served read-only: nothing is stored, nothing is audited, and no ' +
      'collection is read. The Super Admin’s alone — never a tenant role or a support session.',
  })
  prices(): BillingPricesDto {
    return {
      currency: BILLING_CURRENCY,
      // Copies, so a caller holding the answer cannot reach into the constant.
      tiers: BILLING_PRICE_TIERS.map((tier) => ({ ...tier })),
      annualDiscountPct: BILLING_ANNUAL_DISCOUNT_PCT,
    };
  }
}
