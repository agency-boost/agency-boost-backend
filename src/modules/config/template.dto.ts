import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject } from 'class-validator';
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
      + '`activity_taxonomy` is `{ categories, types }`, `lead_pipeline` is `{ statuses }`, '
      + '`ratio_set` is `{ ratios }`.',
  })
  @IsObject()
  payload!: Record<string, unknown>;
}

/** A route parameter, validated so an unknown kind is a 400 rather than an empty answer. */
export class TemplateKindParam {
  @ApiProperty({ enum: TEMPLATE_KINDS })
  @IsIn(TEMPLATE_KINDS as unknown as string[])
  kind!: TemplateKind;
}
