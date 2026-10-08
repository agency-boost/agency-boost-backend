import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  PRODUCT_AGE_BANDS, PRODUCT_BUDGET_BANDS, PRODUCT_NEEDS, type ProductNeed,
} from '@/domain/constants';

/**
 * **The customer brief**, as `GET /attack-plan` reads it from its query (OD-134: the three questions as
 * drawn, `Overall.html:3795-3836`, and no channel).
 *
 * A need, an age band or a budget band outside the domain constants is refused **400**, by name, by the
 * global pipe — as is any other parameter (`forbidNonWhitelisted`). The bands arrive as strings and opt
 * in to the number they are, field by field (`bootstrap.ts`, implicit conversion off).
 */
export class AttackPlanQueryDto {
  @ApiProperty({ enum: PRODUCT_NEEDS, description: '*Primary need*.' })
  @IsIn(PRODUCT_NEEDS)
  need!: ProductNeed;

  @ApiProperty({ enum: PRODUCT_AGE_BANDS, description: '*Age band*: 1 is < 25, 5 is 65+.' })
  @Type(() => Number) @IsInt() @IsIn(PRODUCT_AGE_BANDS)
  age!: number;

  @ApiProperty({ enum: PRODUCT_BUDGET_BANDS, description: '*Monthly premium budget*: 1 is < Rp500K, 7 is Lump-sum.' })
  @Type(() => Number) @IsInt() @IsIn(PRODUCT_BUDGET_BANDS)
  budget!: number;

  @ApiPropertyOptional({
    type: String,
    maxLength: 64,
    example: 'PRUWELL_HEALTH',
    description:
      'The reader switched to this alternative: it is shown, re-fitted against the brief, and the '
      + 'alternatives are the brief’s other matches. A code that is not one of them is not found.',
  })
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64)
  product?: string;
}
