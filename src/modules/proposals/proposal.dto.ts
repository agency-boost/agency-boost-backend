import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow, IsBoolean, IsIn, IsInt, IsMongoId, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  LEAD_AGE, LEAD_GENDERS, PROPOSAL, PROPOSAL_CLIENT_NEEDS, PROPOSAL_CLIENT_STATUSES, PROPOSAL_CLIENT_TEXT_MAX,
  PROPOSAL_INSURED_RELATIONS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_STATUSES,
  type ProposalInsuredRelation, type ProposalPayFrequency, type ProposalStatus,
} from '@/domain/constants';

/**
 * **The proposal's request shapes** (P19.7-T2; `functional/proposal.md`, *Data contract*). The pipe checks the shape —
 * types, enums, bounds that need nothing stored — and the service checks the rest against the stored proposal: an item's
 * field values against its own snapshot (`proposal-items.ts`), a product against the office's shelf (`proposal-offer.ts`).
 */

const PINNED = 'The version you read the proposal at. A stale one is `409 VERSION_CONFLICT`, and nothing is written.';

/** `GET /proposals`: *Riwayat* (ADR-0221 §5). */
export class ListProposalsQueryDto {
  @ApiPropertyOptional({
    type: String, maxLength: PROPOSAL.SEARCH_MAX_LENGTH,
    description: 'Over the client’s name and the products’ names, ignoring case, as the words typed — never a pattern.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PROPOSAL.SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ enum: PROPOSAL_STATUSES })
  @IsOptional()
  @IsIn(PROPOSAL_STATUSES as unknown as string[])
  status?: ProposalStatus;

  @ApiPropertyOptional({ type: String, maxLength: 64, description: 'One lead’s proposals: the lead sheet’s *Proposal* section.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  leadId?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: PROPOSAL.LIST_PAGE_SIZE_MAX, default: PROPOSAL.LIST_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROPOSAL.LIST_PAGE_SIZE_MAX)
  pageSize?: number;
}

/** `GET /proposals/catalog` (ADR-0225 §7; ADR-0255 §8): no channel since P19.14 — a syariah product is its own. */
export class ProposalCatalogQueryDto {
  @ApiPropertyOptional({
    type: Number, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX,
    description: 'The client’s age at the next birthday: each product says `outOfAge` against its entry ages. Absent, none is.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LEAD_AGE.MIN)
  @Max(LEAD_AGE.MAX)
  age?: number;
}

/** *Detail klien* as a write sends it (ADR-0254 §3): read whole by `checkClientDetails`. */
export class ProposalClientDetailsInputDto {
  @ApiPropertyOptional({ enum: PROPOSAL_CLIENT_STATUSES, nullable: true }) status?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_CLIENT_TEXT_MAX.DEPENDANTS }) dependants?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_CLIENT_TEXT_MAX.OCCUPATION }) occupation?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_CLIENT_TEXT_MAX.CITY }) city?: string | null;
  @ApiPropertyOptional({ enum: PROPOSAL_CLIENT_NEEDS, isArray: true, description: 'Stored once each, in order.' }) needs?: string[];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_CLIENT_TEXT_MAX.NEEDS_OTHER, description: 'Kept with `OTHER` only.' }) needsOther?: string | null;
}

/**
 * **The client, as step 1 sends it** (P19.14-T1; ADR-0254 §2): the age at the next birthday and the gender —
 * **required on a new proposal** — and the optional details. The name is the lead's, never sent. Read whole by
 * `proposal-client.ts`, which names the path it refuses.
 */
export class ProposalClientInputDto {
  @ApiPropertyOptional({
    type: Number, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX,
    description: 'The age at the next birthday. Outside 1–100 is `422 LEAD_AGE_OUT_OF_RANGE`, `details: { min, max, field }`.',
  })
  @Allow()
  age?: number;

  @ApiPropertyOptional({ enum: LEAD_GENDERS })
  @Allow()
  gender?: string;

  @ApiPropertyOptional({ type: ProposalClientDetailsInputDto, description: 'Replaces the whole details when sent.' })
  @Allow()
  details?: ProposalClientDetailsInputDto;
}

/** `POST /proposals`: step 1's *Lanjut* (ADR-0221 §3; ADR-0254 §1). */
export class CreateProposalDto {
  @ApiProperty({ type: String, description: 'One of your own live **Sales** leads.' })
  @IsMongoId()
  leadId!: string;

  @ApiProperty({
    type: ProposalClientInputDto,
    description: 'The client’s age and gender (both required) and details — the proposal’s, never written to the lead.',
  })
  @IsObject()
  client!: ProposalClientInputDto;
}

/** A write's pin, alone: `POST …/done`. */
export class PinnedDto {
  @ApiProperty({ type: Number, minimum: 1, description: PINNED })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

/** A write's pin as a query: the two `DELETE`s. */
export class PinnedQueryDto {
  @ApiProperty({ type: Number, minimum: 1, description: PINNED })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

/** `PATCH /proposals/:proposalId`: *Tampilkan total*, and step 1 — the lead and the client. */
export class UpdateProposalDto extends PinnedDto {
  @ApiPropertyOptional({ type: Boolean, description: '*Tampilkan total*.' })
  @IsOptional()
  @IsBoolean()
  showTotal?: boolean;

  @ApiPropertyOptional({
    type: String,
    description: 'Step 1: this lead, or another of your own Sales leads. Takes its name.',
  })
  @IsOptional()
  @IsMongoId()
  leadId?: string;

  @ApiPropertyOptional({
    type: ProposalClientInputDto,
    description: 'Laid over the stored client. A new age removes the products whose entry ages it leaves '
      + '(`removedItemIds`) and holds each client-insured pay term to it.',
  })
  @IsOptional()
  @IsObject()
  client?: ProposalClientInputDto;
}

/** `POST /proposals/:proposalId/items`. */
export class AddProposalItemDto extends PinnedDto {
  @ApiProperty({ type: String, maxLength: 64, description: 'A product step 2’s catalogue offers. Anything else is `422`.' })
  @IsString()
  @MaxLength(64)
  productId!: string;
}

/** *Tertanggung*, as a write sends it. */
export class InsuredPatchDto {
  @ApiProperty({ enum: PROPOSAL_INSURED_RELATIONS })
  @IsIn(PROPOSAL_INSURED_RELATIONS as unknown as string[])
  relation!: ProposalInsuredRelation;

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: PROPOSAL.INSURED_NAME_MAX,
    description: 'Anyone but *Klien*: 1 to 120 characters, or `null` while typed. Omitted keeps what was there.',
  })
  @Allow()
  name?: string | null;

  @ApiPropertyOptional({
    type: Number, nullable: true, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX,
    description: 'Anyone but *Klien*: the age at the next birthday, 1 to 100 (`422 LEAD_AGE_OUT_OF_RANGE`), or `null`.',
  })
  @Allow()
  age?: number | null;

  @ApiPropertyOptional({ enum: LEAD_GENDERS, nullable: true, description: 'Anyone but *Klien*: asked, never required.' })
  @Allow()
  gender?: 'male' | 'female' | null;
}

/** The sum assured, as a write sends it: the currency is the item's own. */
export class UpPatchDto {
  @ApiProperty({
    type: Number, nullable: true, minimum: 0, maximum: PROPOSAL.MONEY_MAX_MINOR,
    description: 'On an `up_premium` product only, minor units of the item’s currency; `null` clears it.',
  })
  @Allow()
  amountMinor!: number | null;
}

/** The premium, as a write sends it: the currency is the item's own. */
export class PremiumPatchDto {
  @ApiProperty({
    type: Number, nullable: true, minimum: 0, maximum: PROPOSAL.PREMIUM_MAX_MINOR,
    description: 'Per *Cara bayar*, in minor units of the item’s currency; `null` clears it.',
  })
  @Allow()
  amountMinor!: number | null;
}

/** `PATCH /proposals/:proposalId/items/:itemId`. */
export class UpdateProposalItemDto extends PinnedDto {
  @ApiPropertyOptional({ type: InsuredPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InsuredPatchDto)
  insured?: InsuredPatchDto;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'integer' }], nullable: true },
    example: { plan: 'Gold', up: 50000000000 },
    description: 'Merged. A `chips` field takes one of its options’ labels; a `money` field minor units of the item’s '
      + 'currency, or `null` to clear it. A `fixed` or `derived` field, or a key the product does not have, is `400`. A '
      + 'change of the currency field empties the item’s money values, its sum assured and its premium.',
  })
  @IsOptional()
  @IsObject()
  fieldValues?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Boolean, description: '*Merokok?*, on a smoker-rated product only.' })
  @IsOptional()
  @IsBoolean()
  smoker?: boolean;

  @ApiPropertyOptional({
    type: String, maxLength: 40,
    description: 'A pay term’s `key` the insured’s age allows. A single term makes *Cara bayar* `single`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  payTerm?: string;

  @ApiPropertyOptional({
    enum: PROPOSAL_PAY_FREQUENCIES,
    description: '*Cara bayar*, one the product offers. A change empties this item’s premium.',
  })
  @IsOptional()
  @IsIn(PROPOSAL_PAY_FREQUENCIES as unknown as string[])
  payFrequency?: ProposalPayFrequency;

  @ApiPropertyOptional({ type: UpPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpPatchDto)
  up?: UpPatchDto;

  @ApiPropertyOptional({ type: PremiumPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PremiumPatchDto)
  premium?: PremiumPatchDto;
}
