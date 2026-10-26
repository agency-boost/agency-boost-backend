import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * `PUT /admin/tenants/:kpmId/activity-binding`: the whole binding, every time (ADR-0163 §3).
 *
 * The types here; what the lists may hold — at least one code each, one role per code, every code one of the
 * office's activity types — is `bindingProblems`', in the service, so the refusal names the role in the
 * client's words rather than a field name.
 */
export class UpdateActivityBindingDto {
  @ApiProperty({
    type: [String], example: ['LEADS_CONTACTED'],
    description: '*Set appointment*: the activity type codes the leads column counts. At least one; archived allowed.',
  })
  @IsArray()
  @IsString({ each: true })
  leads!: string[];

  @ApiProperty({
    type: [String], example: ['SELL_PRESENTATION'],
    description: '*Sales meeting*: the codes the appointments column counts. At least one; archived allowed.',
  })
  @IsArray()
  @IsString({ each: true })
  appointments!: string[];

  @ApiProperty({
    type: [String], example: ['SELL_SUBMISSION'],
    description: '*Submission polis*: the codes the closings column and the pace sentence count. At least one.',
  })
  @IsArray()
  @IsString({ each: true })
  closings!: string[];

  @ApiPropertyOptional({
    type: Number, minimum: 0,
    description: 'The version read. When sent and no longer current, 409 VERSION_CONFLICT and nothing is written.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
