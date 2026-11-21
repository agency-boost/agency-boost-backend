import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProductFieldsDto } from './product.dto';

/** The most products one *Juga sesuai* names: the plan shows a handful, and the list is an order, not a shelf. */
export const ALSO_FITS_MAX = 10;

/**
 * `PUT /admin/companies/:companyId/products/:productId/draft` (P19.23-T4 AC-3; ADR-0278 §4): any of the fields the
 * product's own write takes — *Info produk*'s and the *Sales attack plan*'s — plus *Juga sesuai*. Merged over the draft
 * already saved, field by field. Each field is checked here as the product's write checks it; the product as a whole —
 * a rider's bases, the proposal's settings — when the draft is published.
 */
export class SaveProductDraftDto extends ProductFieldsDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: ALSO_FITS_MAX,
    example: ['PRUWELL_HEALTH'],
    description: '*Juga sesuai*: codes of this company’s other products, in the order the agent’s plan offers them '
      + 'first among a brief’s matches. A code the company does not have, or the product’s own, is `400`.',
  })
  @IsOptional() @IsArray() @ArrayMaxSize(ALSO_FITS_MAX) @ArrayUnique() @IsString({ each: true }) @MaxLength(60, { each: true })
  alsoFits?: string[];
}
