import { ApiProperty } from '@nestjs/swagger';
import type { BillingTier } from '@/domain/constants';

/** One tier of the price list, as `GET /admin/billing/prices` serves it (ADR-0279 §1). */
export class BillingTierDto implements BillingTier {
  @ApiProperty({ type: String, example: 'TIER_1_10', description: 'The tier’s stable code, never its position.' })
  code!: string;

  @ApiProperty({ type: Number, example: 1, description: 'The smallest leader count the tier prices, inclusive.' })
  minLeaders!: number;

  @ApiProperty({ type: Number, nullable: true, example: 10, description: 'The largest, inclusive; `null` for 101+.' })
  maxLeaders!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 50_000_000,
    description: '*Harga standar* per leader per month, IDR minor units (sen); `null` on *Harga khusus*.',
  })
  standardMinor!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 40_000_000,
    description: '*Harga penawaran* per leader per month, IDR minor units; `null` on *Harga khusus*.',
  })
  offerMinor!: number | null;

  @ApiProperty({ type: Boolean, description: '*Harga khusus · diatur per KPM*: the tier draws no price.' })
  customPricing!: boolean;
}

/** *Balik modal*'s parts: one policy's APE and the three percentages, and what they make. */
export class BillingBreakEvenDto {
  @ApiProperty({ example: 2_000_000_000 }) policyApeMinor!: number;
  @ApiProperty({ example: 20 }) commissionPct!: number;
  @ApiProperty({ example: 10, description: 'A placeholder the owner accepted for now (§13.2).' }) overridingPct!: number;
  @ApiProperty({ example: 10, description: 'A placeholder the owner accepted for now (§13.2).' }) bonusPct!: number;
  @ApiProperty({ example: 800_000_000, description: 'APE × (komisi + overriding + bonus).' }) incomePerPolicyMinor!: number;
}

/** The whole list and the calculator's numbers: `GET /admin/billing/prices`. */
export class BillingPricesDto {
  @ApiProperty({ enum: ['IDR'], description: 'The currency of every price.' })
  currency!: 'IDR';

  @ApiProperty({ type: [BillingTierDto], description: 'Smallest leader count first, every count from 1 up covered.' })
  tiers!: BillingTierDto[];

  @ApiProperty({ example: 5, description: '*Tahunan*: the percent off the period’s total.' })
  annualDiscountPct!: number;

  @ApiProperty({ example: 30, description: 'A new KPM’s trial, in days.' })
  trialDays!: number;

  @ApiProperty({ example: 7, description: 'The days after the end before the KPM is suspended.' })
  graceDays!: number;

  @ApiProperty({ example: 30, description: '*Berakhir ≤ 30 hari*.' })
  endingSoonDays!: number;

  @ApiProperty({ example: 30, description: 'The days a month counts for the per-day figures.' })
  daysPerMonth!: number;

  @ApiProperty({ example: 10_000, description: 'The per-day figures round half up to this, in sen (Rp 100).' })
  perDayRoundingMinor!: number;

  @ApiProperty({ example: 100 }) bulkPercentMax!: number;
  @ApiProperty({ example: 500 }) noteMax!: number;
  @ApiProperty({ example: 120 }) kpmNameMax!: number;
  @ApiProperty({ example: 10_000, description: 'The largest *Jumlah leader* or *Jumlah agent*.' }) countMax!: number;
  @ApiProperty({ example: 10_000_000_000, description: 'The largest price per leader per month, in sen.' }) rateMaxMinor!: number;

  @ApiProperty({ type: BillingBreakEvenDto })
  breakEven!: BillingBreakEvenDto;
}

/** A tier as a row names it: *paket 1–10 leader*. */
export class BillingKpmTierDto {
  @ApiProperty({ example: 'TIER_1_10' }) code!: string;
  @ApiProperty({ example: 1 }) minLeaders!: number;
  @ApiProperty({ type: Number, nullable: true, example: 10 }) maxLeaders!: number | null;
}

/** A KPM's company. */
export class BillingKpmCompanyDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
}

/** The Owner, or the Owner named and waiting: *Kirim penawaran* opens WhatsApp to this number. */
export class BillingKpmOwnerDto {
  @ApiProperty({ example: 'Budi Hartono' }) fullName!: string;
  @ApiProperty({ type: String, nullable: true, example: '+6281234567890' }) phone!: string | null;
}

/** *Diskon bulk order* as confirmed. */
export class BillingBulkDiscountDto {
  @ApiProperty({ enum: ['percent', 'amount'] }) type!: 'percent' | 'amount';
  @ApiProperty({ required: false, example: 10 }) percent?: number;
  @ApiProperty({ required: false, example: 100_000_000 }) amountMinor?: number;
}

/** One KPM on *Langganan per KPM* (P19.23-T5 AC-4; ADR-0279 §6). */
export class BillingKpmRowDto {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: '0417' }) code!: string;
  @ApiProperty({ example: 'BSD City Branch' }) branch!: string;
  @ApiProperty({ type: BillingKpmCompanyDto }) company!: BillingKpmCompanyDto;
  @ApiProperty({ enum: ['active', 'suspended'] }) kpmStatus!: 'active' | 'suspended';
  @ApiProperty({ type: BillingKpmOwnerDto, nullable: true }) owner!: BillingKpmOwnerDto | null;
  @ApiProperty({ example: 9, description: '*Leader dipakai*: active ABs and AABs, test accounts never counted.' })
  leadersUsed!: number;
  @ApiProperty({ type: Number, nullable: true, example: 10, description: 'The leaders the package prices; `null`, none.' })
  maxLeaders!: number | null;
  @ApiProperty({ type: BillingKpmTierDto }) tier!: BillingKpmTierDto;
  @ApiProperty({ type: Number, nullable: true, description: '*Harga / leader*, before the annual discount.' })
  rateMinor!: number | null;
  @ApiProperty({ description: '*harga khusus*: other than the tier’s offer price.' }) customPrice!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['six_months', 'annual'] }) plan!: 'six_months' | 'annual' | null;
  @ApiProperty({ description: 'A new KPM’s 30-day trial.' }) trial!: boolean;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-20' }) startDate!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2027-11-19', description: '*Berlaku hingga*.' })
  endDate!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '*Per bulan*: the period’s total ÷ its months.' })
  perMonthMinor!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '*Tagihan per periode*.' }) periodTotalMinor!: number | null;
  @ApiProperty({ type: String, nullable: true, description: 'The grace’s last day, once ended and not kept active.' })
  graceEndsOn!: string | null;
  @ApiProperty({
    type: String, nullable: true, enum: ['suspended', 'ended', 'over', 'trial', 'ending_soon'],
    description: 'The one pill: *Ditangguhkan*, *Berakhir*, *Melewati batas*, *Trial*, *Berakhir ≤ 30 hari*.',
  })
  attention!: 'suspended' | 'ended' | 'over' | 'trial' | 'ending_soon' | null;
  @ApiProperty({ description: '*Perlu tindakan*: ended, over the limit, a trial, or ending within 30 days.' })
  needsAction!: boolean;
  @ApiProperty({ type: Number, nullable: true }) agents!: number | null;
  @ApiProperty({ type: BillingBulkDiscountDto, nullable: true }) bulkDiscount!: BillingBulkDiscountDto | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

/** The navy summary: every KPM, whatever the filter. */
export class BillingSummaryDto {
  @ApiProperty({ description: '*Pendapatan per bulan*.' }) monthlyRevenueMinor!: number;
  @ApiProperty({ description: '*dari n KPM berbayar*.' }) payingKpms!: number;
  @ApiProperty({ description: '*Leader ditagih*.' }) leadersBilled!: number;
  @ApiProperty({ description: '*Berakhir ≤ 30 hari*: trials and periods ending within 30 days.' }) endingSoon!: number;
  @ApiProperty({ description: '*Perlu tindakan*.' }) needsAction!: number;
  @ApiProperty({ description: '*Semua n*.' }) kpms!: number;
}

/** The *Total* row over the rows shown. */
export class BillingTotalDto {
  @ApiProperty() kpms!: number;
  @ApiProperty() leadersUsed!: number;
  @ApiProperty({ type: Number, nullable: true, description: '*rata-rata tertimbang*.' }) weightedRateMinor!: number | null;
  @ApiProperty() perMonthMinor!: number;
  @ApiProperty({ description: '*semua periode berjalan*.' }) periodTotalMinor!: number;
  @ApiProperty() needsAction!: number;
}

/** `GET /admin/billing/kpms`. */
export class BillingKpmListDto {
  @ApiProperty({ type: BillingSummaryDto }) summary!: BillingSummaryDto;
  @ApiProperty({ type: BillingTotalDto }) total!: BillingTotalDto;
  @ApiProperty({ type: [BillingKpmRowDto] }) rows!: BillingKpmRowDto[];
}
