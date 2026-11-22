import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsMongoId, IsOptional, IsString } from 'class-validator';

/**
 * How many insurers one grant may tick: every insurer on the platform, with room. A bound on one request's work, not a
 * business number — the platform has a handful.
 */
export const GRANT_COMPANIES_MAX = 100;

/**
 * `PUT /admin/product-data-grants/:userId` (ADR-0260 §4): ***Kelola data produk*** on, for the companies ticked. Gives
 * it, or changes the companies of the live one. An empty list is refused — switching it off is the `DELETE`.
 */
export class SetProductDataGrantDto {
  @ApiProperty({
    type: [String],
    description: 'The insurer companies the person may manage, each a company id; at least one. A company that is not '
      + 'an insurer, or does not exist, is `400 VALIDATION_FAILED` naming it, and nothing is written.',
  })
  @IsArray() @ArrayMaxSize(GRANT_COMPANIES_MAX) @ArrayUnique() @IsMongoId({ each: true })
  companyIds!: string[];
}

/** `GET /admin/product-data-grants/changes?cursor=` (ADR-0260 §6): the next page of *Perubahan oleh pengelola*. */
export class ProductDataChangesQuery {
  @ApiPropertyOptional({ type: String, description: 'The `page.nextCursor` of the page before; absent for the first.' })
  @IsOptional() @IsString()
  cursor?: string;
}
