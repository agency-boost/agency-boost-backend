import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '@/common/auth/auth.decorators';
import {
  BILLING, BILLING_ANNUAL_DISCOUNT_PCT, BILLING_BREAK_EVEN, BILLING_CURRENCY, BILLING_INCOME_PER_POLICY_MINOR,
  BILLING_PRICE_TIERS, SUBSCRIPTION,
} from '@/domain/constants';
import { BillingPricesDto } from './billing.response.dto';

/**
 * *Paket & harga* and the calculator's numbers (ADR-0279 §1; `functional/billing.md`).
 *
 * **It stores nothing and reads nothing stored.** The price list is a domain constant, served so the browser's
 * calculator never re-declares it (invariant §7). So the controller has no constructor: no repository, no model, no
 * audit writer. That is the structural proof that the route reads no collection and writes no audit row, and the int
 * spec builds it with no providers at all, so a dependency added later fails there before it ships.
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
    summary: 'Paket & harga: the price list and the calculator’s numbers',
    description:
      'Every tier by its stable code: the leader-count bounds (the last open), *Harga standar* and *Harga penawaran* ' +
      'per leader per month in IDR minor units (`null` on 101+, *Harga khusus*); the annual discount (5%), the trial ' +
      '(30 days), the grace before a lapsed KPM is suspended (7 days), *Berakhir ≤ 30 hari*, the per-day divisor and ' +
      'rounding, the calculator’s bounds, and *Balik modal*’s parts. A constant served read-only: nothing is stored, ' +
      'nothing is audited, and no collection is read. The Super Admin’s alone — never a tenant role or a support session.',
  })
  prices(): BillingPricesDto {
    const b = BILLING_BREAK_EVEN;
    return {
      currency: BILLING_CURRENCY,
      // Copies, so a caller holding the answer cannot reach into the constant.
      tiers: BILLING_PRICE_TIERS.map((tier) => ({ ...tier })),
      annualDiscountPct: BILLING_ANNUAL_DISCOUNT_PCT,
      trialDays: BILLING.TRIAL_DAYS,
      graceDays: BILLING.GRACE_DAYS,
      endingSoonDays: BILLING.ENDING_SOON_DAYS,
      daysPerMonth: BILLING.DAYS_PER_MONTH,
      perDayRoundingMinor: BILLING.PER_DAY_ROUNDING_MINOR,
      bulkPercentMax: BILLING.BULK_PERCENT_MAX,
      noteMax: BILLING.NOTE_MAX,
      kpmNameMax: BILLING.KPM_NAME_MAX,
      countMax: BILLING.COUNT_MAX,
      rateMaxMinor: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR,
      breakEven: {
        policyApeMinor: b.POLICY_APE_MINOR,
        commissionPct: b.COMMISSION_PCT,
        overridingPct: b.OVERRIDING_PCT,
        bonusPct: b.BONUS_PCT,
        incomePerPolicyMinor: BILLING_INCOME_PER_POLICY_MINOR,
      },
    };
  }
}
