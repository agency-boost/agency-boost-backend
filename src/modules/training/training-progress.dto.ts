import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { TRAINING_STATUSES, type TrainingStatus } from '@/domain/constants';

/**
 * **`for`, and nothing else** (P18.5-T4): whose training. The validation pipe refuses a parameter of any other
 * name by name rather than ignoring it, and an empty `for` rather than reading it as the caller's own.
 */
export class TrainingProgressQueryDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 64,
    description:
      'The **membership** whose training to read. Omitted, or your own, it is yours. Anybody else is read as far as '
      + 'your grant reaches: the people you coach, or the whole office for its Owner and Admins. Every read of '
      + 'somebody else’s is recorded.',
  })
  @IsOptional() @IsString() @Length(1, 64)
  for?: string;
}

/** A module's page takes no query: the pipe refuses any parameter by name. */
export class TrainingModuleQueryDto {}

/** Opening an item takes no body: the item is in the address. The pipe refuses any field by name. */
export class OpenTrainingItemDto {}

/** The status the member sets on one module — set, never toggled (OD-149: their own word). */
export class SetTrainingStatusDto {
  @ApiProperty({ enum: TRAINING_STATUSES, example: 'done' })
  @IsIn(TRAINING_STATUSES as unknown as string[])
  status!: TrainingStatus;
}
