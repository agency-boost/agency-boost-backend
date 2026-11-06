import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow, IsBoolean, IsIn, IsInt, IsMongoId, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  LEAD_AGE, PROPOSAL, PROPOSAL_CHANNELS, PROPOSAL_INSURED_RELATIONS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_STATUSES,
  type ProposalChannel, type ProposalInsuredRelation, type ProposalPayFrequency, type ProposalStatus,
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

/** `GET /proposals/catalog` (ADR-0225 §7). */
export class ProposalCatalogQueryDto {
  @ApiProperty({ enum: PROPOSAL_CHANNELS })
  @IsIn(PROPOSAL_CHANNELS as unknown as string[])
  channel!: ProposalChannel;

  @ApiProperty({ type: Number, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX, description: 'The client’s age at the next birthday.' })
  @Type(() => Number)
  @IsInt()
  @Min(LEAD_AGE.MIN)
  @Max(LEAD_AGE.MAX)
  age!: number;
}

/** `POST /proposals`: step 1's *Lanjut* (ADR-0221 §3). */
export class CreateProposalDto {
  @ApiProperty({
    type: String,
    description: 'One of your own live **Sales** leads, with an age and a gender — step 1 saves them to the lead first.',
  })
  @IsMongoId()
  leadId!: string;
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

/** `PATCH /proposals/:proposalId`: the settings, and step 1's lead. */
export class UpdateProposalDto extends PinnedDto {
  @ApiPropertyOptional({ enum: PROPOSAL_CHANNELS, description: '*Konvensional / Syariah*. Items no longer offered are removed.' })
  @IsOptional()
  @IsIn(PROPOSAL_CHANNELS as unknown as string[])
  channel?: ProposalChannel;

  @ApiPropertyOptional({ enum: PROPOSAL_PAY_FREQUENCIES, description: '*Cara bayar*. A change empties every premium.' })
  @IsOptional()
  @IsIn(PROPOSAL_PAY_FREQUENCIES as unknown as string[])
  payFrequency?: ProposalPayFrequency;

  @ApiPropertyOptional({ type: Boolean, description: '*Tampilkan total premi*.' })
  @IsOptional()
  @IsBoolean()
  showTotal?: boolean;

  @ApiPropertyOptional({
    type: String,
    description: 'Step 1: this lead, or another of your own Sales leads. Takes the client’s copy again; items no longer '
      + 'offered at the client’s age are removed.',
  })
  @IsOptional()
  @IsMongoId()
  leadId?: string;
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
      + 'currency, or `null` to clear it. A `fixed` field or a key the product does not have is `400`. A change of the '
      + 'currency field empties the item’s money values and its premium.',
  })
  @IsOptional()
  @IsObject()
  fieldValues?: Record<string, unknown>;

  @ApiPropertyOptional({ type: PremiumPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PremiumPatchDto)
  premium?: PremiumPatchDto;
}
