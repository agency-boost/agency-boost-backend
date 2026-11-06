import { ApiProperty } from '@nestjs/swagger';
import {
  LEAD_GENDERS, PDF_DETAIL_BLOCKS, PRODUCT_CATEGORIES, PRODUCT_CURRENCIES, PROPOSAL, PROPOSAL_CHANNELS,
  PROPOSAL_FIELD_TYPES, PROPOSAL_INSURED_RELATIONS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_STATUSES,
} from '@/domain/constants';

/**
 * **The proposal's answers, as the API document describes them** (P19.7-T2; `functional/proposal.md`). The frontend's
 * `lib/proposals.ts` declares the same shapes, held to these by `contract.spec.ts`.
 */

export class ProposalOptionViewDto {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'On the `paymentYears` field: the term’s whole years.' }) years!: number | null;
  @ApiProperty({ enum: PRODUCT_CURRENCIES, nullable: true, description: 'On the `currency` field.' }) currency!: string | null;
}

/** A field of a product's panel: the catalogue's, less the Super Admin's *Perlu dicek* mark. */
export class ProposalFieldViewDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The label a *Syariah* proposal reads.' }) labelSyariah!: string | null;
  @ApiProperty({ enum: PROPOSAL_FIELD_TYPES }) type!: string;
  @ApiProperty({ type: [ProposalOptionViewDto] }) options!: ProposalOptionViewDto[];
  @ApiProperty({ type: String, nullable: true }) default!: string | null;
  @ApiProperty({ type: [Number], description: 'IDR minor units; offered on an IDR item only.' }) quickAmounts!: number[];
  @ApiProperty({ type: Number, nullable: true, description: 'The least sum, IDR minor units.' }) minMinor!: number | null;
  @ApiProperty({ type: Boolean }) showOnPdf!: boolean;
  @ApiProperty({ type: Boolean }) showOnSummary!: boolean;
  @ApiProperty({ type: Boolean }) paymentYears!: boolean;
  @ApiProperty({ type: Boolean }) plan!: boolean;
  @ApiProperty({ type: Boolean }) currency!: boolean;
}

export class PdfDetailRowViewDto {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true }) formula!: string | null;
  @ApiProperty({ type: String, nullable: true }) text!: string | null;
}

export class PdfDetailBlockViewDto {
  @ApiProperty({ enum: PDF_DETAIL_BLOCKS }) block!: string;
  @ApiProperty({ type: [PdfDetailRowViewDto] }) rows!: PdfDetailRowViewDto[];
  @ApiProperty({ type: Boolean, description: '*tidak dijamin*, on `nilai_tunai` only.' }) notGuaranteed!: boolean;
}

/** What an item copied from its product when it was added — never refreshed (ADR-0225 §6). */
export class ProposalSnapshotDto {
  @ApiProperty({ type: String, description: 'The office’s name for it then.' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) syariahName!: string | null;
  @ApiProperty({ type: String, example: 'KESEHATAN' }) typeLabel!: string;
  @ApiProperty({ enum: PRODUCT_CATEGORIES }) category!: string;
  @ApiProperty({ enum: PRODUCT_CURRENCIES, isArray: true }) currencies!: string[];
  @ApiProperty({ type: [ProposalFieldViewDto] }) fields!: ProposalFieldViewDto[];
  @ApiProperty({ type: [String], maxItems: PROPOSAL.BENEFITS_ON_PDF_MAX }) benefits!: string[];
  @ApiProperty({ type: [PdfDetailBlockViewDto] }) pdfDetail!: PdfDetailBlockViewDto[];
}

export class ProposalInsuredDto {
  @ApiProperty({ enum: PROPOSAL_INSURED_RELATIONS }) relation!: string;
  @ApiProperty({ type: String, nullable: true, description: '`null` for *Klien*.' }) name!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '`null` for *Klien*.' }) age!: number | null;
}

export class ProposalMoneyDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Minor units of `currency`; `null` until typed.' }) amountMinor!: number | null;
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
}

export class ProposalTotalDto {
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
  @ApiProperty({ type: Number, description: 'Minor units. Never summed across currencies.' }) amountMinor!: number;
}

export class ProposalTotalPaidDto {
  @ApiProperty({ type: Number, description: 'The premium × payments a year × years, minor units.' }) amountMinor!: number;
  @ApiProperty({ type: Number }) years!: number;
}

export class ProposalItemDto {
  @ApiProperty({ type: String }) itemId!: string;
  @ApiProperty({ type: String }) productId!: string;
  @ApiProperty({ type: String }) productCode!: string;
  @ApiProperty({ type: Number }) productVersion!: number;
  @ApiProperty({ type: String, description: 'The name this proposal shows: the syariah name on a *Syariah* one, where it has one.' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The `plan` field’s value.' }) plan!: string | null;
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
  @ApiProperty({ type: ProposalSnapshotDto }) snapshot!: ProposalSnapshotDto;
  @ApiProperty({ type: ProposalInsuredDto }) insured!: ProposalInsuredDto;
  @ApiProperty({
    type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    description: 'A `chips` field’s option label; a `money` field’s minor units. A `fixed` field holds nothing.',
  })
  fieldValues!: Record<string, string | number>;

  @ApiProperty({ type: ProposalMoneyDto }) premium!: ProposalMoneyDto;
  @ApiProperty({ type: ProposalTotalPaidDto, nullable: true, description: '*Total dibayar*; `null` without a premium or whole years.' }) totalPaid!: ProposalTotalPaidDto | null;
  @ApiProperty({ type: String, nullable: true, enum: ['A', 'B'], description: 'Always `null`: the compare mode is *Later*.' }) choice!: null;
}

export class ProposalClientDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: Number, description: 'The age at the next birthday when taken.' }) age!: number;
  @ApiProperty({ enum: LEAD_GENDERS }) gender!: string;
}

/** The proposal, as every route answers it. */
export class ProposalResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: Number, description: 'What the next write pins (`expectedVersion`).' }) version!: number;
  @ApiProperty({ type: String }) leadId!: string;
  @ApiProperty({ type: Boolean, description: 'The lead was deleted: the proposal stays, under the client’s name.' }) leadDeleted!: boolean;
  @ApiProperty({ type: ProposalClientDto }) client!: ProposalClientDto;
  @ApiProperty({ enum: PROPOSAL_CHANNELS }) channel!: string;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES }) payFrequency!: string;
  @ApiProperty({ type: Boolean }) showTotal!: boolean;
  @ApiProperty({ enum: PROPOSAL_STATUSES, description: '*Draf* or *Selesai*. Any write makes it a *Draf* again.' }) status!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) doneAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) firstDoneAt!: string | null;
  @ApiProperty({ type: String, example: '2026-11-05', description: 'The KPM’s day: the day of `doneAt`, else today.' }) date!: string;
  @ApiProperty({
    type: String, example: 'Proposal-Pak-Budi-Santoso-2026-11-05.pdf',
    description: 'The PDF’s file name (ADR-0222 §6): `Proposal-{Nama klien}-{date}.pdf`. The screen saves the file under it.',
  }) fileName!: string;
  @ApiProperty({ type: [ProposalItemDto], maxItems: PROPOSAL.ITEMS_MAX }) items!: ProposalItemDto[];
  @ApiProperty({ type: [ProposalTotalDto], description: '*Total premi*, one per currency, IDR first.' }) totals!: ProposalTotalDto[];
  @ApiProperty({ type: String, nullable: true }) duplicatedFrom!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

/** `PATCH /proposals/:proposalId`'s answer. */
export class ProposalPatchedDto extends ProposalResponseDto {
  @ApiProperty({ type: [String], description: 'The items a channel or age change took out, because no longer offered.' })
  removedItemIds!: string[];
}

/** `POST /proposals/:proposalId/duplicate`'s answer. */
export class ProposalDuplicatedDto extends ProposalResponseDto {
  @ApiProperty({ type: [String], description: 'The products left out because they are no longer offered.' })
  droppedProductIds!: string[];
}

export class ProposalRowClientDto {
  @ApiProperty({ type: String }) name!: string;
}

export class ProposalRowProductDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, nullable: true }) plan!: string | null;
}

/** One line of *Riwayat*. */
export class ProposalRowDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: Number }) version!: number;
  @ApiProperty({ type: ProposalRowClientDto }) client!: ProposalRowClientDto;
  @ApiProperty({ type: String, example: '2026-11-05', description: 'The day it was finished, else the day it last changed.' }) date!: string;
  @ApiProperty({
    type: String, example: 'Proposal-Pak-Budi-Santoso-2026-11-05.pdf',
    description: 'The file name *Unduh lagi* saves the PDF under: its finished day, or today for a *Draf* (ADR-0222 §6).',
  }) fileName!: string;
  @ApiProperty({ type: [ProposalRowProductDto] }) products!: ProposalRowProductDto[];
  @ApiProperty({ enum: PROPOSAL_STATUSES }) status!: string;
  @ApiProperty({ type: [ProposalTotalDto] }) totals!: ProposalTotalDto[];
  @ApiProperty({ type: String }) leadId!: string;
  @ApiProperty({ type: Boolean }) leadDeleted!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class ProposalPageDto {
  @ApiProperty({ type: [ProposalRowDto] }) rows!: ProposalRowDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
}

export class ProposalPlanHighlightDto {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) value!: string;
}

export class ProposalCatalogPlanDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: [ProposalPlanHighlightDto], description: 'The office’s approved highlights, else the company’s.' }) highlights!: ProposalPlanHighlightDto[];
  @ApiProperty({ type: Boolean, description: '*Paling banyak dipilih*.' }) popular!: boolean;
}

export class ProposalFaqDto {
  @ApiProperty({ type: String }) question!: string;
  @ApiProperty({ type: String }) answer!: string;
}

export class ProposalRiderDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) name!: string;
}

/** A product step 2 may add (ADR-0225 §7). */
export class ProposalCatalogProductDto {
  @ApiProperty({ type: String }) productId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String, description: 'The office’s name; a conventional product’s syariah name on *Syariah*.' }) name!: string;
  @ApiProperty({ enum: PRODUCT_CATEGORIES, description: 'The card’s icon.' }) category!: string;
  @ApiProperty({ type: String, example: 'KESEHATAN' }) typeLabel!: string;
  @ApiProperty({ enum: ['client', 'child'] }) defaultInsured!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { fixed: 'IDR' },
    description: '`{ fixed: "IDR" | "USD" }`, or `{ byField: <key> }` where the product sells both and its `currency` field decides.',
  })
  currency!: { fixed: string } | { byField: string };

  @ApiProperty({ type: [ProposalFieldViewDto] }) fields!: ProposalFieldViewDto[];
  @ApiProperty({ type: [ProposalCatalogPlanDto], description: 'Cheapest to richest.' }) plans!: ProposalCatalogPlanDto[];
  @ApiProperty({ type: [ProposalFaqDto], description: '*Tanya-jawab*: for the agent, never printed. Empty hides the link.' }) faq!: ProposalFaqDto[];
  @ApiProperty({ type: [ProposalRiderDto], description: '*"Bisa ditambah: …"* — never a card, never an item.' }) riders!: ProposalRiderDto[];
}

export class ProposalCatalogDto {
  @ApiProperty({ type: [ProposalCatalogProductDto] }) products!: ProposalCatalogProductDto[];
}
