import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { BILLING, SUBSCRIPTION_PLANS, type SubscriptionPlan } from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { BILLING_REFUSALS } from './billing.messages';

const SAY = BILLING_REFUSALS.VALIDATION_FAILED;

/** *Semua* or *Perlu tindakan* on *Langganan per KPM* (P19.23-T5 AC-4). */
export const BILLING_KPM_FILTERS = ['all', 'needs_action'] as const;
export type BillingKpmFilter = (typeof BILLING_KPM_FILTERS)[number];

/** `GET /admin/billing/kpms?filter=` (ADR-0279 §6). Anything else is refused. */
export class BillingKpmsQueryDto {
  @ApiPropertyOptional({
    enum: BILLING_KPM_FILTERS,
    description: '`all` (the default) or `needs_action` — the rows and the *Total* row; the summary always reads every KPM.',
  })
  @IsOptional()
  @IsIn(BILLING_KPM_FILTERS, { message: field(SAY.filter) })
  filter?: BillingKpmFilter;
}

/** How the price is typed: per leader per month, or the period's total before the bulk discount (*isi total*). */
export class OfferPriceDto {
  @ApiProperty({ enum: ['per_leader', 'total'] })
  @IsIn(['per_leader', 'total'], { message: field(SAY.priceMode) })
  mode!: 'per_leader' | 'total';

  @ApiPropertyOptional({
    example: 35_000_000,
    description: 'With `per_leader`: *Harga / leader / bulan*, IDR minor units, whole rupiah, from 0 to Rp 100.000.000.',
  })
  @ValidateIf((o: OfferPriceDto) => o.mode === 'per_leader')
  @IsInt({ message: field(SAY.rate) })
  @Min(0, { message: field(SAY.rate) })
  rateMinor?: number;

  @ApiPropertyOptional({
    example: 2_475_000_000,
    description: 'With `total`: the period’s total before the bulk discount, IDR minor units, whole rupiah.',
  })
  @ValidateIf((o: OfferPriceDto) => o.mode === 'total')
  @IsInt({ message: field(SAY.total) })
  @Min(0, { message: field(SAY.total) })
  totalMinor?: number;
}

/** *Diskon bulk order*: a whole percent, or an amount in sen. */
export class BulkDiscountDto {
  @ApiProperty({ enum: ['percent', 'amount'] })
  @IsIn(['percent', 'amount'], { message: field(SAY.bulkType) })
  type!: 'percent' | 'amount';

  @ApiPropertyOptional({ example: 10, description: 'With `percent`: a whole number from 0 to 100.' })
  @ValidateIf((o: BulkDiscountDto) => o.type === 'percent')
  @IsInt({ message: field(SAY.percent) })
  @Min(0, { message: field(SAY.percent) })
  percent?: number;

  @ApiPropertyOptional({ example: 100_000_000, description: 'With `amount`: IDR minor units, whole rupiah, up to the total.' })
  @ValidateIf((o: BulkDiscountDto) => o.type === 'amount')
  @IsInt({ message: field(SAY.amount) })
  @Min(0, { message: field(SAY.amount) })
  amountMinor?: number;
}

/**
 * **The calculator's inputs** (ADR-0279 §2): what *Konfirmasi paket* stores and *Buat PDF* prints. **No figure**: the
 * server prices them (`price-offer.ts`), so a total the browser worked out is never trusted.
 */
export class OfferInputDto {
  @ApiProperty({ example: 22, minimum: 1, description: '*Jumlah leader*: the leaders priced.' })
  @IsInt({ message: field(SAY.leaders) })
  @Min(1, { message: field(SAY.leaders) })
  leaders!: number;

  @ApiPropertyOptional({ example: 80, nullable: true, description: '*Jumlah agent (Opsional)*: never billed.' })
  @IsOptional()
  @IsInt({ message: field(SAY.agents) })
  @Min(0, { message: field(SAY.agents) })
  agents?: number | null;

  @ApiProperty({ enum: SUBSCRIPTION_PLANS, description: '*Tahunan* (`annual`, 5% off) or *6 bulan* (`six_months`).' })
  @IsIn(SUBSCRIPTION_PLANS, { message: field(SAY.plan) })
  plan!: SubscriptionPlan;

  @ApiProperty({ type: OfferPriceDto })
  @ValidateNested()
  @Type(() => OfferPriceDto)
  price!: OfferPriceDto;

  @ApiPropertyOptional({ type: BulkDiscountDto, nullable: true, description: '*Diskon bulk order*; absent or null, none.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkDiscountDto)
  bulk?: BulkDiscountDto | null;

  @ApiProperty({ example: '2026-11-20', description: '*Mulai*, an office date, YYYY-MM-DD.' })
  @IsString({ message: field(SAY.date) })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.date) })
  startDate!: string;

  @ApiProperty({ example: '2027-11-19', description: '*Berakhir*, on or after the start: the last day the KPM is served.' })
  @IsString({ message: field(SAY.date) })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.date) })
  endDate!: string;

  @ApiPropertyOptional({ example: 'KPM baru, komitmen 1 tahun', nullable: true, description: '*Catatan (Opsional)*.' })
  @IsOptional()
  @IsString({ message: field(SAY.note) })
  @MaxLength(BILLING.NOTE_MAX, { message: field(SAY.note) })
  note?: string | null;
}

/** **`PUT /admin/billing/kpms/:kpmId/subscription`** — *Konfirmasi paket* / *Pakai untuk KPM* (ADR-0279 §3). */
export class ConfirmPackageDto extends OfferInputDto {}

/**
 * **`POST /admin/billing/offer`** — *Buat PDF* (ADR-0279 §7): the calculator's inputs, and the KPM it is for — an
 * existing one by id, or a new one by the name typed.
 */
export class OfferPdfDto extends OfferInputDto {
  @ApiPropertyOptional({ description: 'An existing KPM, picked in *KPM*. Its name and company are the server’s.' })
  @IsOptional()
  @IsMongoId({ message: field(SAY.kpmName) })
  kpmId?: string;

  @ApiPropertyOptional({ example: 'Serpong Branch', description: 'A KPM that does not exist yet, as typed in *KPM*.' })
  @IsOptional()
  @IsString({ message: field(SAY.kpmName) })
  @MaxLength(BILLING.KPM_NAME_MAX, { message: field(SAY.kpmName) })
  kpmName?: string;
}
