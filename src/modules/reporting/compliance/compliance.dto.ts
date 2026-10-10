import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey } from './compliance-category';

/** An item's bound: module and campaign codes are at most 40 characters, an event's id 24. */
export const COMPLIANCE_ITEM_MAX = 100;

/**
 * `category` and `item`, and nothing else (P18.6-T1 AC-1): a category it does not know, an empty or over-long item, or
 * a parameter of any other name is 400 `VALIDATION_FAILED`, named in `details`. An `item` on a single-item category is
 * refused by the service, with the same code.
 */
export class ComplianceQueryDto {
  @ApiPropertyOptional({
    enum: COMPLIANCE_CATEGORIES,
    default: 'training',
    description: 'The category whose tree is read, in the summary’s order. Every chip is computed whatever it is.',
  })
  @IsOptional()
  @IsIn(COMPLIANCE_CATEGORIES)
  category?: ComplianceCategoryKey;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: COMPLIANCE_ITEM_MAX,
    description:
      'The item whose statuses the tree shows: a training module’s **code**, an event’s **id**, a campaign’s **code**. '
      + 'Absent, the first the office lists. Refused on `goals`, `activity` and `activation`, which hold one item; an '
      + 'item the office does not list — another office’s, archived, outside this year — is 404.',
  })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_ITEM_MAX)
  item?: string;
}
