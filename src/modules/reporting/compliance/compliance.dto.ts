import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { COMPLIANCE_CATEGORIES, type ComplianceCategoryKey } from './compliance-category';

/** An item's bound: module and campaign codes are at most 40 characters, an event's id 24. */
export const COMPLIANCE_ITEM_MAX = 100;

/**
 * `category`, `item` and `group`, and nothing else (P18.3-T1 AC-1; `group` since P19.3-T3; the KPM Overview's since
 * P19.19-T3): a category it does not know, an empty or over-long item, or a parameter of any other name is 400
 * `VALIDATION_FAILED`, named in `details`. An `item` without a category, or on a single-item category, is refused by the
 * service, with the same code.
 */
export class ComplianceQueryDto {
  @ApiPropertyOptional({
    enum: COMPLIANCE_CATEGORIES,
    description: 'The card opened: its people’s cells are read. Absent, the seven cards alone. Every card is computed '
      + 'whatever it is.',
  })
  @IsOptional()
  @IsIn(COMPLIANCE_CATEGORIES)
  category?: ComplianceCategoryKey;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: COMPLIANCE_ITEM_MAX,
    description:
      'The item whose statuses the card shows: a training module’s **code**, an event’s **id**, a campaign’s **code**. '
      + 'Absent: Training’s first module; *Semua event*, *Semua campaign*. Refused on `goals`, `activity`, `leads` and '
      + '`activation`, which hold one item; an item the office does not list — another office’s, archived, outside this '
      + 'year — is 404.',
  })
  @IsOptional()
  @IsString()
  @Length(1, COMPLIANCE_ITEM_MAX)
  item?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      '*Semua group ⌄*: one of the office’s informal groups by id, or `none` for *Tanpa group* — the '
      + 'cards and the cells are then over its people today. An unknown or archived group, or another office’s, is 404.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  group?: string;
}
