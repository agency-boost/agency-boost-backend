import { ApiProperty } from '@nestjs/swagger';
import {
  CALC_LIMIT_KINDS, CALC_NOTES, CALC_STATES, LEAD_AGE, LEAD_GENDERS, PDF_DETAIL_BLOCKS, PRODUCT_CATEGORIES, PRODUCT_CURRENCIES, PROPOSAL, PROPOSAL_CALC_TYPES,
  PROPOSAL_CLIENT_NEEDS, PROPOSAL_CLIENT_STATUSES, PROPOSAL_FIELD_TYPES, PROPOSAL_FIXED_FIELDS, PROPOSAL_INSURED_RELATIONS,
  PROPOSAL_NEED_TAGS, PROPOSAL_PAY_FREQUENCIES, PROPOSAL_STATUSES, type ProposalClientNeed, type ProposalClientStatus,
} from '@/domain/constants';
import { EntryAgeDto, PayTermDto, PlanRuleDto } from '@/modules/products/product.dto';

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
  @ApiProperty({ type: String, nullable: true, description: 'The label a syariah product reads, where it differs.' }) labelSyariah!: string | null;
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

export class ProposalSnapshotLimitsDto {
  @ApiProperty({ type: Number, nullable: true }) upStep!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMax!: number | null;
}

/** What an item copied from its product when it was added — never refreshed (ADR-0225 §6; ADR-0255 §6). */
export class ProposalSnapshotDto {
  @ApiProperty({ type: String, description: 'The office’s name for it then.' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Read by nothing since P19.14 (ADR-0255 §1).' }) syariahName!: string | null;
  @ApiProperty({ type: String, example: 'KESEHATAN' }) typeLabel!: string;
  @ApiProperty({ enum: PRODUCT_CATEGORIES }) category!: string;
  @ApiProperty({ enum: PROPOSAL_NEED_TAGS, description: 'The PDF’s need tile it ticks.' }) needTag!: string;
  @ApiProperty({ type: Boolean, description: 'A syariah product: *Kontribusi*, *Santunan asuransi*, *Peserta*.' }) isSyariah!: boolean;
  @ApiProperty({ enum: PROPOSAL_CALC_TYPES, description: '`up_premium` shows the sum assured beside the premium.' }) calcType!: string;
  @ApiProperty({ enum: PRODUCT_CURRENCIES, isArray: true }) currencies!: string[];
  @ApiProperty({ type: [ProposalFieldViewDto] }) fields!: ProposalFieldViewDto[];
  @ApiProperty({ type: PlanRuleDto, nullable: true }) planRule!: PlanRuleDto | null;
  @ApiProperty({ type: [PayTermDto] }) payTerms!: PayTermDto[];
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, isArray: true, description: '*Cara bayar* offered; never empty.' }) frequencies!: string[];
  @ApiProperty({ type: Boolean }) smokerRated!: boolean;
  @ApiProperty({ type: EntryAgeDto, nullable: true }) entryAge!: EntryAgeDto | null;
  @ApiProperty({ type: ProposalSnapshotLimitsDto }) limits!: ProposalSnapshotLimitsDto;
  @ApiProperty({ type: [String], maxItems: PROPOSAL.BENEFITS_ON_PDF_MAX }) benefits!: string[];
  @ApiProperty({ type: [PdfDetailBlockViewDto] }) pdfDetail!: PdfDetailBlockViewDto[];
}

export class ProposalInsuredDto {
  @ApiProperty({ enum: PROPOSAL_INSURED_RELATIONS }) relation!: string;
  @ApiProperty({ type: String, nullable: true, description: '`null` for *Klien*.' }) name!: string | null;
  @ApiProperty({ type: Number, nullable: true, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX, description: '`null` for *Klien*.' }) age!: number | null;
  @ApiProperty({ enum: LEAD_GENDERS, nullable: true, description: '`null` for *Klien*; asked, never required.' }) gender!: string | null;
}

export class ProposalMoneyDto {
  @ApiProperty({ type: Number, description: 'Minor units of `currency`.' }) amountMinor!: number;
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
}

export class ProposalTotalDto {
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, description: 'Summed per *Cara bayar* as well as per currency.' }) payFrequency!: string;
  @ApiProperty({ type: Number, description: 'Minor units. Never summed across currencies or *Cara bayar*.' }) amountMinor!: number;
  @ApiProperty({ type: Number, description: 'How many items it sums.' }) items!: number;
}

/** One limit the amounts fall outside, and the chip with the nearest allowed value (P19.15-T1 AC-5). */
export class CalcLimitDto {
  @ApiProperty({ enum: CALC_LIMIT_KINDS }) kind!: string;
  @ApiProperty({ type: Number, description: 'The limit, minor units — a premium limit per year.' }) limitMinor!: number;
  @ApiProperty({ type: Object, nullable: true, description: '`{ field: up | premium | goal, amountMinor }`: *"— pakai Rp100 jt"*.' }) chip!: { field: string; amountMinor: number } | null;
}

/** **What the card shows of its calculation** (P19.15-T1; ADR-0258 §5). */
export class ItemCalcDto {
  @ApiProperty({ enum: ['table', 'manual'] }) mode!: string;
  @ApiProperty({ enum: CALC_STATES }) state!: string;
  @ApiProperty({ type: String, nullable: true }) tableId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: '*"Tabel tarif berlaku {tanggal}"*.' }) effectiveFrom!: string | null;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, isArray: true, description: 'The *Cara bayar* the table prices for this item.' }) frequencies!: string[];
  @ApiProperty({ type: CalcLimitDto, nullable: true }) limit!: CalcLimitDto | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The UP step behind *"Premi disesuaikan"*.' }) stepMinor!: number | null;
  @ApiProperty({ type: String, nullable: true, enum: ['age', 'gender', null] }) missing!: string | null;
  @ApiProperty({ type: Object, nullable: true, description: '`{ min, max }` for `age_outside`.' }) ageBounds!: { min: number | null; max: number | null } | null;
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
  @ApiProperty({ type: String, description: 'The product’s name, as the item copied it.' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The `plan` field’s value.' }) plan!: string | null;
  @ApiProperty({ enum: PRODUCT_CURRENCIES }) currency!: string;
  @ApiProperty({ type: ProposalSnapshotDto }) snapshot!: ProposalSnapshotDto;
  @ApiProperty({ type: ProposalInsuredDto }) insured!: ProposalInsuredDto;
  @ApiProperty({
    type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    description: 'A `chips` field’s option label; a `money` field’s minor units; a `derived` field’s value, worked out by '
      + 'the server. A `fixed` field holds nothing.',
  })
  fieldValues!: Record<string, string | number>;

  @ApiProperty({ type: Boolean, nullable: true, description: '*Merokok?*: `false` by default where smoker-rated, else `null`.' }) smoker!: boolean | null;
  @ApiProperty({ type: String, nullable: true, description: 'The chosen pay term’s `key` in `snapshot.payTerms`.' }) payTerm!: string | null;
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, description: '*Cara bayar*, the item’s own.' }) payFrequency!: string;
  @ApiProperty({ type: ProposalMoneyDto, nullable: true, description: 'The sum assured, on an `up_premium` product.' }) up!: ProposalMoneyDto | null;
  @ApiProperty({ type: ProposalMoneyDto, nullable: true, description: 'Per *Cara bayar*; `null` until typed.' }) premium!: ProposalMoneyDto | null;
  @ApiProperty({ enum: PROPOSAL_FIXED_FIELDS, description: 'The amount typed last, which a calculation keeps; `none` on a typed (`manual`) item.' }) fixedField!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The premium table version the amounts came from (ADR-0258); `null` — typed.' }) rateTableVersionId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'That version\'s *Berlaku mulai*, `YYYY-MM-DD`.' }) rateTableEffectiveFrom!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: [...CALC_NOTES, null], description: 'The card\'s one-line note, a code: `up_rounded`, `rates_updated`, `table_off`.' }) calcNote!: string | null;
  @ApiProperty({ type: ItemCalcDto, nullable: true, description: 'What the card shows of its calculation (ADR-0258 §5); `null` on a typed item.' }) calc!: ItemCalcDto | null;
  @ApiProperty({ type: ProposalTotalPaidDto, nullable: true, description: '*Total dibayar*; `null` without a premium, for *Sekali bayar*, or without whole years.' }) totalPaid!: ProposalTotalPaidDto | null;
  @ApiProperty({ type: String, nullable: true, enum: ['A', 'B'], description: 'Always `null`: the compare mode is *Later*.' }) choice!: null;
}

/** *Detail klien* (ADR-0254 §3): each prints only when filled. */
export class ProposalClientDetailsDto {
  @ApiProperty({ enum: PROPOSAL_CLIENT_STATUSES, nullable: true, description: '*Lajang* or *Menikah*.' }) status!: ProposalClientStatus | null;
  @ApiProperty({ type: String, nullable: true, description: '*Tanggungan*.' }) dependants!: string | null;
  @ApiProperty({ type: String, nullable: true }) occupation!: string | null;
  @ApiProperty({ type: String, nullable: true }) city!: string | null;
  @ApiProperty({ enum: PROPOSAL_CLIENT_NEEDS, isArray: true, description: '*Yang dibahas*, in order.' }) needs!: ProposalClientNeed[];
  @ApiProperty({ type: String, nullable: true, description: '*Lainnya*’s words, with `OTHER` only.' }) needsOther!: string | null;
}

/** The client, on the proposal and nowhere else (ADR-0254 §1). */
export class ProposalClientDto {
  @ApiProperty({ type: String, description: 'The lead’s name, copied when chosen.' }) name!: string;
  @ApiProperty({ type: Number, nullable: true, minimum: LEAD_AGE.MIN, maximum: LEAD_AGE.MAX, description: 'The age at the next birthday on `ageSetOn`.' }) age!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-12', description: 'The KPM’s day the age was entered.' }) ageSetOn!: string | null;
  @ApiProperty({ enum: LEAD_GENDERS, nullable: true }) gender!: string | null;
  @ApiProperty({ type: ProposalClientDetailsDto }) details!: ProposalClientDetailsDto;
}

/** The proposal, as every route answers it. */
export class ProposalResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: Number, description: 'What the next write pins (`expectedVersion`).' }) version!: number;
  @ApiProperty({ type: String }) leadId!: string;
  @ApiProperty({ type: Boolean, description: 'The lead was deleted: the proposal stays, under the client’s name.' }) leadDeleted!: boolean;
  @ApiProperty({ type: ProposalClientDto }) client!: ProposalClientDto;
  @ApiProperty({ type: Boolean, description: '*Tampilkan total*.' }) showTotal!: boolean;
  @ApiProperty({ enum: PROPOSAL_STATUSES, description: '*Draf* or *Selesai*. Any write makes it a *Draf* again.' }) status!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) doneAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) firstDoneAt!: string | null;
  @ApiProperty({ type: String, example: '2026-11-05', description: 'The KPM’s day: the day of `doneAt`, else today.' }) date!: string;
  @ApiProperty({
    type: String, example: 'Proposal-Pak-Budi-Santoso-2026-11-05.pdf',
    description: 'The PDF’s file name (ADR-0222 §6): `Proposal-{Nama klien}-{date}.pdf`. The screen saves the file under it.',
  }) fileName!: string;
  @ApiProperty({ type: [ProposalItemDto], maxItems: PROPOSAL.ITEMS_MAX }) items!: ProposalItemDto[];
  @ApiProperty({ type: [ProposalTotalDto], description: '*Total premi*, one per currency and *Cara bayar*, IDR first.' }) totals!: ProposalTotalDto[];
  @ApiProperty({ type: String, nullable: true }) duplicatedFrom!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

/** `PATCH /proposals/:proposalId`'s answer. */
export class ProposalPatchedDto extends ProposalResponseDto {
  @ApiProperty({ type: [String], description: 'The items a change of the client’s age took out: outside their entry ages.' })
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
  @ApiProperty({ type: String, description: 'The office’s name for it.' }) name!: string;
  @ApiProperty({ enum: PRODUCT_CATEGORIES, description: 'The card’s icon.' }) category!: string;
  @ApiProperty({ type: String, example: 'KESEHATAN', description: 'Step 2’s category chip.' }) typeLabel!: string;
  @ApiProperty({ enum: PROPOSAL_NEED_TAGS }) needTag!: string;
  @ApiProperty({ type: Boolean, description: 'A syariah product: *Kontribusi*, *Santunan asuransi*, *Peserta*.' }) isSyariah!: boolean;
  @ApiProperty({ enum: PROPOSAL_CALC_TYPES }) calcType!: string;
  @ApiProperty({ enum: ['client', 'child'] }) defaultInsured!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { fixed: 'IDR' },
    description: '`{ fixed: "IDR" | "USD" }`, or `{ byField: <key> }` where the product sells both and its `currency` field decides.',
  })
  currency!: { fixed: string } | { byField: string };

  @ApiProperty({ type: [ProposalFieldViewDto] }) fields!: ProposalFieldViewDto[];
  @ApiProperty({ type: [PayTermDto] }) payTerms!: PayTermDto[];
  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, isArray: true }) frequencies!: string[];
  @ApiProperty({ type: Boolean }) smokerRated!: boolean;
  @ApiProperty({ type: PlanRuleDto, nullable: true }) planRule!: PlanRuleDto | null;
  @ApiProperty({ type: EntryAgeDto, nullable: true }) entryAge!: EntryAgeDto | null;
  @ApiProperty({ type: Boolean, description: 'The client’s age is outside `entryAge`: greyed, never added.' }) outOfAge!: boolean;
  @ApiProperty({ type: [ProposalCatalogPlanDto], description: 'Cheapest to richest.' }) plans!: ProposalCatalogPlanDto[];
  @ApiProperty({ type: [ProposalFaqDto], description: '*Tanya-jawab*: for the agent, never printed. Empty hides the link.' }) faq!: ProposalFaqDto[];
  @ApiProperty({ type: [ProposalRiderDto], description: '*"Bisa ditambah: …"* — never a card, never an item.' }) riders!: ProposalRiderDto[];
}

export class ProposalCatalogDto {
  @ApiProperty({ type: [ProposalCatalogProductDto] }) products!: ProposalCatalogProductDto[];
}
