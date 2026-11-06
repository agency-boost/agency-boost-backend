import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, Min } from 'class-validator';
import { TEMPLATE_KINDS, type TemplateKind } from './company-template.schema';

export class SaveTemplateDraftDto {
  /**
   * The whole template, not a patch.
   *
   * A template is edited as one document and copied as one document; a partial update
   * would need the server to merge two versions of a list, and "merge" on an ordered list
   * of codes has no answer anybody would predict.
   */
  @ApiProperty({
    type: Object,
    description:
      'The whole payload for this kind. Shape depends on the kind: '
      + '`activity_taxonomy` is `{ categories, types }` — a category may carry '
      + '`summaryGroupCode` and `summaryGroupLabel`, both or neither (ADR-0064) — '
      + '`lead_pipeline` is `{ statuses }`, `ratio_set` is `{ ratios }`.',
  })
  @IsObject()
  payload!: Record<string, unknown>;

  /**
   * The `revision` the editor read (P19-T6 AC-2; the 11-03 handover's B1-10) — of the draft, else of the newest
   * published, else `0`. Not `version`: a draft's is the number it will be published as, and does not move when it
   * is saved.
   */
  @ApiPropertyOptional({
    example: 3,
    minimum: 0,
    description: 'The `revision` of what the editor opened — the draft, else the newest published, else `0` for '
      + 'nothing. Somebody else saved or published since: `409 VERSION_CONFLICT`, `details.expectedRevision` and '
      + '`details.actualRevision`, nothing written. Absent, the save lands whatever the revision.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}

/** A route parameter, validated so an unknown kind is a 400 rather than an empty answer. */
export class TemplateKindParam {
  @ApiProperty({ enum: TEMPLATE_KINDS })
  @IsIn(TEMPLATE_KINDS as unknown as string[])
  kind!: TemplateKind;
}
