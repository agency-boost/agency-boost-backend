import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Two shapes the console returns straight from Mongoose, which is why they are described
 * here rather than generated from a service interface.
 *
 * Both are worth flagging: a raw document is what put an ObjectId in a column headed
 * **Owner** before P3.1-T14, and returning one means the wire shape is whatever the
 * schema happens to hold. `CompanyResponseDto` documents what a client may rely on.
 */
export class CompanyResponseDto {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, description: 'Derived from the name by the console, and unique among companies that are not deleted.' })
  slug!: string;

  @ApiProperty({ type: String, example: 'IDR', description: 'Fixed for v1 (ADR-0016). Every office inherits it.' })
  defaultCurrency!: string;

  @ApiProperty({ type: String, example: 'id-ID', description: 'Fixed for v1.' })
  defaultLocale!: string;

  @ApiProperty({ type: String, example: 'Asia/Jakarta', description: 'Fixed for v1 (ADR-0016). Every day boundary in every office of this company resolves here.' })
  defaultTimezone!: string;

  @ApiProperty({ type: String, enum: ['active', 'suspended'] })
  status!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'False means this company was created blank: no product catalog, no carrier rules, '
      + 'and every Company template tab starts empty rather than from the platform\'s presets.',
  })
  usesPlatformDefaults!: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '**On `GET /admin/companies` only.** *Dimulai kosong* on `/admin/companies` (SA UI-017): made blank '
      + '(`usesPlatformDefaults: false`) **and** its default template has no published section yet — *Advanced '
      + 'analytics*, which every template is made holding, aside. False once one section is published, or for a company '
      + 'that took the presets. A write\'s answer leaves it out: a company just made blank has nothing published.',
  })
  startedBlank?: boolean;

  @ApiProperty({
    type: String,
    enum: ['insurer', 'template'],
    description:
      '`insurer` for every company people work for. `template` for the one Template library, which holds '
      + 'the templates a new company and a new office copy: nobody registers under it, and it holds no office.',
  })
  kind!: 'insurer' | 'template';
}

/** One row of the append-only platform log. Read-only by construction — there is no edit. */
export class AuditEntryResponseDto {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String, example: 'kpm.provisioned' })
  action!: string;

  @ApiProperty({
    type: String,
    example: 'Draf template disimpan',
    description:
      '**The action in the reader\'s words** (SA UI-016), never its code — *"Analytics KPM 0417 '
      + 'dilihat"* where it names the KPM it read. The action as recorded where no label names it.',
  })
  actionLabel!: string;

  @ApiProperty({ type: String, example: 'kpms' })
  targetCollection!: string;

  @ApiProperty({
    type: String,
    example: 'Produk',
    description: 'What kind of thing the target is, in the reader\'s words; the collection\'s name where nothing names it.',
  })
  targetKind!: string;

  @ApiProperty({ type: String, nullable: true })
  targetId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Prudential template · Aktivitas & rasio',
    description:
      'What the target is called (SA UI-016) — a person\'s name, *KPM 0417 · Bandung*, a company\'s '
      + 'name, a template\'s, *"<template> · <section>"* for a template\'s section, a product\'s, a rung\'s, a KPM '
      + 'request\'s branch; an office\'s own record by the member it is about, else its KPM. Deleted ones are still named. '
      + '**Null when the id resolves to nothing, or to a collection nothing names yet**, '
      + 'and the reader is shown the id instead: a blank cell would read as nothing happened.',
  })
  targetLabel!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The real actor. Under impersonation this stays the Super Admin.' })
  actorUserId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The real actor\'s name, or null if the account is gone.' })
  actorName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Who they were acting as, when this was a support session.' })
  effectiveUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  effectiveName!: string | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  before?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  after?: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

/**
 * What a visitor with no account may know about an insurer.
 *
 * Two fields, deliberately, and the service projects rather than filters — so a field
 * added to `companies` later cannot arrive here by default. Which insurers exist is not a
 * secret; how each is configured is.
 */
export class PublicCompanyDto {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String, example: 'Prudential' })
  name!: string;
}
