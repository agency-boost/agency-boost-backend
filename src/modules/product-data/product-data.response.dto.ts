import { ApiProperty } from '@nestjs/swagger';
import {
  PRODUCT_DATA_CHECK_REASONS, PRODUCT_DATA_STATUSES, PROPOSAL_CALC_TYPES, PROPOSAL_PAY_FREQUENCIES, RATE_BASES,
  RATE_COLUMN_ROLES, RATE_TABLE_SOURCES, RATE_TABLE_STATUSES,
} from '@/domain/constants';
import { ProposalItemDto } from '@/modules/proposals/proposal.response.dto';

/**
 * **The *Proposal* tab's answers, as the OpenAPI document describes them** (ADR-0258; `functional/proposal.md`, *Proposal
 * data per insurer › Premium tables and the card*). Shapes only: `product-data.service.ts` and `rate-table.service.ts`
 * build them.
 */

class IdNameDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) name!: string;
}

class ActorDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The person’s full name, where it can be read.' }) name!: string | null;
}

class ProductDataCountersDto {
  @ApiProperty({ type: Number, description: '*Perlu dicek*.' }) check!: number;
  @ApiProperty({ type: Number, description: '*Ketik manual*.' }) manual!: number;
  @ApiProperty({ type: Number, description: '*Siap hitung*.' }) ready!: number;
  @ApiProperty({ type: Number, description: '*Ditarik*.' }) withdrawn!: number;
}

class LastUpdatedDto {
  @ApiProperty({ type: String, format: 'date-time' }) at!: string;
  @ApiProperty({ type: ActorDto, nullable: true }) by!: ActorDto | null;
}

class ProductDataTableCellDto {
  @ApiProperty({ enum: ['active', 'none', 'ending', 'gaps'], description: '*Berlaku …*, *Belum ada*, *Berakhir …*, *Ada celah*.' })
  state!: string;

  @ApiProperty({ type: String, nullable: true }) id!: string | null;
  @ApiProperty({ type: Number, nullable: true }) version!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-04-01' }) effectiveFrom!: string | null;
  @ApiProperty({ type: String, nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ type: Number }) gapCount!: number;
  @ApiProperty({ type: String, nullable: true, description: '*"Tarif baru mulai {date}"*.' }) scheduledFrom!: string | null;
}

class ProductDataIllustrationCellDto {
  @ApiProperty({ enum: ['published', 'none'] }) state!: string;
  @ApiProperty({ type: Number }) blocks!: number;
}

/** One row of the product list (the P1b spec §2). */
export class ProductDataRowDto {
  @ApiProperty({ type: String }) productId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) category!: string;
  @ApiProperty({ type: Boolean }) isSyariah!: boolean;
  @ApiProperty({ enum: PROPOSAL_CALC_TYPES }) calcType!: string;
  @ApiProperty({ type: String }) lifecycle!: string;
  @ApiProperty({ enum: PRODUCT_DATA_STATUSES }) status!: string;
  @ApiProperty({ enum: PRODUCT_DATA_CHECK_REASONS, isArray: true, description: 'Why it is *Perlu dicek*.' }) checkReasons!: string[];
  @ApiProperty({ type: ProductDataTableCellDto }) table!: ProductDataTableCellDto;
  @ApiProperty({ type: ProductDataIllustrationCellDto }) illustration!: ProductDataIllustrationCellDto;
}

/** `GET /product-data/companies/:companyId/products`: the four counters and one row per product. */
export class ProductDataOverviewDto {
  @ApiProperty({ type: IdNameDto }) company!: IdNameDto;
  @ApiProperty({ type: Boolean, description: 'Whether the reader may change anything here.' }) canManage!: boolean;
  @ApiProperty({ type: ProductDataCountersDto }) counters!: ProductDataCountersDto;
  @ApiProperty({ type: LastUpdatedDto, nullable: true, description: '*"Terakhir diperbarui: {date} oleh {name}"*.' })
  lastUpdated!: LastUpdatedDto | null;

  @ApiProperty({ type: ProductDataRowDto, isArray: true, description: '*Perlu dicek*, *Ketik manual*, *Siap hitung*, *Ditarik*.' })
  products!: ProductDataRowDto[];
}

/** A version's rules, minor units; premium limits per year. */
export class RateRulesDto {
  @ApiProperty({ type: Number, nullable: true }) upStep!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) entryAgeMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) entryAgeMax!: number | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, description: '`{ [payTermKey]: age }`.' })
  payTermMaxAge!: Record<string, number>;
}

/** The *Cara bayar* factors against the annual premium. */
export class FrequencyFactorsDto {
  @ApiProperty({ type: Number, nullable: true }) monthly!: number | null;
  @ApiProperty({ type: Number, nullable: true }) quarterly!: number | null;
  @ApiProperty({ type: Number, nullable: true }) semiannual!: number | null;
  @ApiProperty({ type: Number, nullable: true }) annual!: number | null;
}

class RateSourceDto {
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ enum: RATE_TABLE_SOURCES }) type!: string;
}

class RateGapDto {
  @ApiProperty({ enum: ['ages', 'combination', 'smoker', 'gender', 'plan', 'payTerm', 'currency'] }) kind!: string;
  @ApiProperty({ type: Number, required: false }) from?: number;
  @ApiProperty({ type: Number, required: false }) to?: number;
  @ApiProperty({ type: String, required: false, nullable: true }) plan?: string | null;
  @ApiProperty({ type: String, required: false, nullable: true }) payTerm?: string | null;
  @ApiProperty({ type: String, required: false, nullable: true }) payTermLabel?: string | null;
  @ApiProperty({ type: String, required: false, nullable: true }) gender?: string | null;
  @ApiProperty({ type: Boolean, required: false, nullable: true }) smoker?: boolean | null;
  @ApiProperty({ type: String, required: false, nullable: true }) currency?: string | null;
}

class RateTestInputDto {
  @ApiProperty({ type: Number }) age!: number;
  @ApiProperty({ enum: ['male', 'female'] }) gender!: string;
  @ApiProperty({ type: Boolean, nullable: true }) smoker!: boolean | null;
  @ApiProperty({ type: String, nullable: true }) plan!: string | null;
  @ApiProperty({ type: String, nullable: true }) payTerm!: string | null;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES }) payFrequency!: string;
  @ApiProperty({ type: Number }) amountMinor!: number;
}

class RateTestCaseViewDto {
  @ApiProperty({ type: RateTestInputDto }) inputs!: RateTestInputDto;
  @ApiProperty({ type: Number, description: 'The premium the illustration prints.' }) expectedMinor!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'The app’s own result.' }) actualMinor!: number | null;
  @ApiProperty({ type: Boolean, description: 'Within Rp1.' }) match!: boolean;
}

class KetentuanProblemDto {
  @ApiProperty({ type: Number }) row!: number;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) value!: string;
}

class RateFileDto {
  @ApiProperty({ type: String, isArray: true }) header!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', enum: [...RATE_COLUMN_ROLES] } })
  columnMap!: Record<string, string>;

  @ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'The first rows.' })
  preview!: string[][];

  @ApiProperty({ type: Number }) rows!: number;
  @ApiProperty({ type: Boolean, description: 'The file has a *Ketentuan* sheet.' }) ketentuan!: boolean;
  @ApiProperty({ type: KetentuanProblemDto, isArray: true }) ketentuanProblems!: KetentuanProblemDto[];
}

class RatePreviousDto {
  @ApiProperty({ type: RateRulesDto }) rules!: RateRulesDto;
  @ApiProperty({ type: FrequencyFactorsDto }) frequencies!: FrequencyFactorsDto;
  @ApiProperty({ enum: ['version', 'catalogue'] }) from!: string;
  @ApiProperty({ type: Number, nullable: true }) version!: number | null;
}

/** **A premium table version** (ADR-0258 §2): its state worked out on the read. */
export class RateTableViewDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) productId!: string;
  @ApiProperty({ type: Number }) version!: number;
  @ApiProperty({ enum: RATE_TABLE_STATUSES }) status!: string;
  @ApiProperty({ type: String, example: '2026-04-01', description: '*Berlaku mulai*.' }) effectiveFrom!: string;
  @ApiProperty({ type: String, nullable: true, description: '*Berlaku sampai*.' }) effectiveTo!: string | null;
  @ApiProperty({ type: RateSourceDto }) source!: RateSourceDto;
  @ApiProperty({ type: String, format: 'date-time' }) uploadedAt!: string;
  @ApiProperty({ type: ActorDto }) uploadedBy!: ActorDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) activatedAt!: string | null;
  @ApiProperty({ type: ActorDto, nullable: true }) activatedBy!: ActorDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) turnedOffAt!: string | null;
  @ApiProperty({ type: ActorDto, nullable: true }) turnedOffBy!: ActorDto | null;
  @ApiProperty({ enum: [...RATE_BASES, null], nullable: true }) basis!: string | null;
  @ApiProperty({ type: Boolean, description: '*Cocokkan kolom* confirmed.' }) mapped!: boolean;
  @ApiProperty({ type: Number }) rowCount!: number;
  @ApiProperty({ type: RateGapDto, isArray: true, description: '*Cek kelengkapan*, the first 50.' }) gaps!: RateGapDto[];
  @ApiProperty({ type: Number }) gapCount!: number;
  @ApiProperty({ type: RateTestCaseViewDto, isArray: true, description: '*Uji 3 contoh*.' }) testCases!: RateTestCaseViewDto[];
  @ApiProperty({ type: String, nullable: true }) overrideReason!: string | null;
  @ApiProperty({ type: RateRulesDto }) rules!: RateRulesDto;
  @ApiProperty({ type: FrequencyFactorsDto }) frequencies!: FrequencyFactorsDto;
  @ApiProperty({ enum: ['ketentuan', 'previous', 'catalogue', 'typed', 'intake'] }) rulesSource!: string;
  @ApiProperty({ type: Boolean, description: 'Rules read from a file are saved by a person before activation.' }) rulesConfirmed!: boolean;
  @ApiProperty({ type: Boolean, description: 'A proposal was calculated with it: it is never deleted.' }) used!: boolean;
  @ApiProperty({ type: RateFileDto, nullable: true, description: 'A draft’s file; `null` once activated.' }) file!: RateFileDto | null;
  @ApiProperty({ type: RatePreviousDto, description: 'What the rules replace — old → new.' }) previous!: RatePreviousDto;
}

class ProductDataProductDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) category!: string;
  @ApiProperty({ type: String }) channel!: string;
  @ApiProperty({ type: Boolean }) isSyariah!: boolean;
  @ApiProperty({ type: String }) lifecycle!: string;
  @ApiProperty({ type: Number, description: 'Pinned by *Isian*’s save.' }) version!: number;
  @ApiProperty({ type: String, isArray: true }) currencies!: string[];
  @ApiProperty({ type: String }) kind!: string;
  @ApiProperty({
    type: 'object', additionalProperties: true,
    description: '*Isian*’s values: `proposalFields`, `planOptions`, `syariahName`, `defaultInsured`, `proposalTypeLabel`, '
      + '`currencies`, and the calculation fields (`calcType`, `entryAge`, `payTerms`, `frequencies`, `smokerRated`, '
      + '`planRule`, `upStep`, `upMin`, `upMax`, `premiumMin`, `premiumMax`, `needTag`), as the catalogue holds them.',
  })
  rules!: Record<string, unknown>;
}

/** `GET …/products/:productId` and `PATCH …/rules`: one product, *Isian*'s values and every version. */
export class ProductDataDetailDto {
  @ApiProperty({ type: ProductDataProductDto }) product!: ProductDataProductDto;
  @ApiProperty({ type: Boolean }) canManage!: boolean;
  @ApiProperty({ type: RateRulesDto, description: 'The catalogue’s values as a version’s rules.' }) catalogueRules!: RateRulesDto;
  @ApiProperty({ type: RateTableViewDto, nullable: true }) inForce!: RateTableViewDto | null;
  @ApiProperty({ type: RateTableViewDto, nullable: true }) scheduled!: RateTableViewDto | null;
  @ApiProperty({ type: RateTableViewDto, isArray: true, description: 'Newest first.' }) versions!: RateTableViewDto[];
}

class PdfBoxRowDto {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) value!: string;
  @ApiProperty({ enum: ['value', 'detail', 'benefit', 'cash'] }) kind!: string;
}

class PdfTileDto {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) value!: string;
}

class PdfFactDto {
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, nullable: true }) text!: string | null;
}

/** The product's PDF box, as the PDF model draws it. */
class PdfBoxDto {
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) typeLabel!: string;
  @ApiProperty({ type: String }) who!: string;
  @ApiProperty({ type: String, nullable: true }) premium!: string | null;
  @ApiProperty({ type: String }) per!: string;
  @ApiProperty({ type: String }) pill!: string;
  @ApiProperty({ type: String, description: '*"Tabel tarif berlaku …"* or *"Premi dari ilustrasi resmi"*.' }) source!: string;
  @ApiProperty({ type: PdfBoxRowDto, isArray: true }) rows!: PdfBoxRowDto[];
  @ApiProperty({ type: PdfTileDto, isArray: true }) protection!: PdfTileDto[];
  @ApiProperty({ type: PdfFactDto, isArray: true }) facts!: PdfFactDto[];
}

/** `POST …/products/:productId/try`: the item as the agent's card reads it, and the PDF box. Nothing stored. */
export class ProductTryDto {
  @ApiProperty({ type: ProposalItemDto }) item!: ProposalItemDto;
  @ApiProperty({ type: PdfBoxDto }) box!: PdfBoxDto;
}
