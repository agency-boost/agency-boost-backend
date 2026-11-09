import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { StartFromDto } from '@/modules/config/named-template.dto';
import {
  IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max,
  MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import {
  AGENT_CODE_PATTERN, DEFAULT_TENANT_TIMEZONE, LEADER_TIERS, ROSTER_UPLOAD, SUBSCRIPTION, SUBSCRIPTION_PLANS, type LeaderTier,
  type SubscriptionPlan,
} from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { PHONE_FIELD_SHAPE, phoneFromBody } from '@/modules/users/phone-input';
import { TENANTS_REFUSALS } from './tenants.messages';

/** The DTOs' own sentences, in both languages (P18.10-T5 AC-3): `field` carries them to the pipe. */
const SAY = TENANTS_REFUSALS.VALIDATION_FAILED;

/**
 * A rung's leader tier on the wire (ADR-0156): `senior`, `associate`, or `null` for *Not a leader*.
 * `@IsOptional` passes `null` through, which is the point — `null` is a value here, and only a string
 * outside the two tiers is refused.
 */
const LEADER_TIER_PROPERTY = {
  enum: [...LEADER_TIERS],
  nullable: true,
  description:
    '*Senior Leader* (what AB is), *Associate Leader* (what AAB is), or `null` — *Not a leader*. A member\u2019s '
    + 'role class is derived from it wherever they are placed on the rung (ADR-0156).',
};

export class CreateCompanyDto {
  @ApiProperty({ example: 'Prudential', minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /**
   * The console derives this from the name and lets it be edited, so the pattern is
   * tighter than "the characters we allow": it is the shape derivation actually
   * produces. `-`, `--a--` and `---` all passed the old `/^[a-z0-9-]+$/` and none of
   * them can come out of the deriver, which made a hand-typed slug expressible in ways
   * a derived one never is.
   */
  @ApiProperty({
    example: 'prudential',
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Derived from the name by the console and editable there. Unique among companies ' +
      'that have not been deleted; a clash is refused with COMPANY_SLUG_TAKEN.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: field(SAY.slugShape) })
  slug!: string;

  /**
   * Start this company from the Template library, or from nothing (ADR-0164 §4).
   *
   * **Default true, and absent means true** — a company created before this field existed,
   * and every caller that does not care, gets what they always got.
   */
  @ApiPropertyOptional({
    default: true,
    description:
      'True copies the Template library: its role ladder with the leader tiers, product catalog, '
      + 'carrier rules and recruitment playbook, and its Default template — activity taxonomy, ratios, '
      + 'lead ladders, training tree, activation checklist, capability ladder and event types — as the '
      + 'company\'s first, default template. A copy: changing the Template later changes no company made '
      + 'from it. Where no Template library exists, the AgencyBoost defaults. False leaves every one of '
      + 'them empty, for a company whose presets are being authored from scratch. The role ladder is '
      + 'seeded either way: an office whose company has none is one nobody can join.',
  })
  @IsOptional()
  @IsBoolean()
  usesPlatformDefaults?: boolean;
}

/** Renaming a company. The slug is separate from the name and both are optional. */
export class UpdateCompanyDto {
  @ApiPropertyOptional({ example: 'Prudential Indonesia', minLength: 2, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    example: 'prudential-id',
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description:
      'Changeable: nothing stores it. Every office points at the company by id, and the '
      + 'slug is a label. A clash is refused with COMPANY_SLUG_TAKEN.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: field(SAY.slugShape) })
  slug?: string;
}

/** Suspending a company, or bringing it back. */
export class SetCompanyStatusDto {
  @ApiProperty({ enum: ['active', 'suspended'] })
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}

/**
 * A rung on a company's ladder.
 *
 * `code` is write-once by construction: it is on the create DTO and deliberately absent
 * from the update one. Invariant 3 — a published code never changes, because it is the
 * identity every membership and every history row holds.
 */
export class CreateOrgLevelDto {
  @ApiProperty({ description: 'Company id from GET /admin/companies' })
  @IsMongoId()
  companyId!: string;

  @ApiProperty({
    example: 'AAB',
    description: 'Stable and semantic. Upper-cased on the way in, and never changed afterwards.',
    pattern: '^[A-Z][A-Z0-9_]{1,31}$',
  })
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_]{1,31}$/, { message: field(SAY.rungCodeShape) })
  code!: string;

  @ApiProperty({ example: 'Associate Agency Business', minLength: 1, maxLength: 60 })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;

  @ApiProperty({ example: 2, description: 'Junior first. Presentation only — nothing references it.' })
  @IsInt()
  @Min(1)
  @Max(99)
  displayOrder!: number;

  @ApiPropertyOptional({ ...LEADER_TIER_PROPERTY, description: `${LEADER_TIER_PROPERTY.description} Absent is \`null\`.` })
  @IsOptional()
  @IsIn([...LEADER_TIERS])
  leaderTier?: LeaderTier | null;
}

/** No `code`. Renaming is what `label` is for; a different rung is a different level. */
export class UpdateOrgLevelDto {
  @ApiPropertyOptional({ example: 'Associate Agency Business', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  displayOrder?: number;

  @ApiPropertyOptional({
    ...LEADER_TIER_PROPERTY,
    description: `${LEADER_TIER_PROPERTY.description} Refused \`409 ORG_LEVEL_TIER_IN_USE\` while anybody holds the rung.`,
  })
  @IsOptional()
  @IsIn([...LEADER_TIERS])
  leaderTier?: LeaderTier | null;

  @ApiPropertyOptional({
    enum: ['active', 'archived'],
    description: 'Archiving retires a rung without deleting it. Nothing is ever deleted here.',
  })
  @IsOptional()
  @IsEnum(['active', 'archived'])
  status?: 'active' | 'archived';

  @ApiPropertyOptional({
    example: 3,
    minimum: 0,
    description: 'The rung\'s `version` as read, `0` for a rung never changed. A rung changed since is '
      + 'refused `409 VERSION_CONFLICT` with `details.expectedVersion` and `details.actualVersion`, and nothing is '
      + 'written. Absent, unchecked.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

/** `DELETE /admin/org-levels/:id?expectedVersion=` (ADR-0213 §2): the rung as read, or unchecked. */
export class DeleteOrgLevelQueryDto {
  @ApiPropertyOptional({
    example: 4,
    minimum: 0,
    description: 'The rung\'s `version` as read. A rung changed since — restored, renamed — is refused `409 '
      + 'VERSION_CONFLICT`, nothing written. Absent, unchecked.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

/**
 * ***Pemilik KPM*** (ADR-0212 §1; P19.4-T3 AC-6; the setup spec's A-R1, A2): the person who will run the KPM, named
 * when it is made — or, through *Ganti pemilik*, given later. *Nama* and *No. WhatsApp* are required; the invitation
 * goes **by email** (ADR-0010), so without one the Owner waits, named (`kpms.pendingOwner`, *Belum diundang*).
 */
export class OwnerInputDto {
  @ApiProperty({ example: 'Wulan Kartika', minLength: 2, maxLength: 120 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: field(SAY.ownerNameShort) })
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({
    example: '0812 7700 6020',
    description: 'Their WhatsApp number — **stored and shown, never a channel**: nothing is sent by WhatsApp or SMS '
      + '(ADR-0212 §4). Spaces, dashes, dots and brackets go, and a leading `+62`, `62` or `0`; what is left must be 9 '
      + 'to 13 digits, stored as `+62…`, else `400 VALIDATION_FAILED` naming `owner.phone`.',
  })
  @Transform(({ value }) => phoneFromBody(value))
  @Matches(PHONE_FIELD_SHAPE, { message: field(SAY.ownerPhoneShape) })
  phone!: string;

  @ApiPropertyOptional({
    example: 'wulan.kartika@example.test',
    description: 'Where the invitation goes. An existing account with it becomes the Owner (its company, an agent '
      + 'code and a verified address required, ADR-0191 §5); with none, an account is made for it with no usable '
      + 'password. Absent: no account, the Owner waits named (`pendingOwner`).',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value))
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    example: '70045001',
    description: '*Kode agen pemilik*: their code at the insurer. Required to make a new account (the Owner is the '
      + 'KPM’s root AB under it); an existing account keeps its own.',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  @Matches(AGENT_CODE_PATTERN, { message: field(SAY.ownerAgentCodeShape) })
  agentCode?: string;
}

export class CreateKpmDto {
  @ApiProperty({ description: 'Company id from GET /admin/companies' })
  @IsString()
  companyId!: string;

  @ApiProperty({ example: '0417', description: 'Unique within the company. Prefixes agent codes.' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{2,16}$/)
  code!: string;

  @ApiProperty({ example: 'BSD City Branch' })
  @IsString()
  @MinLength(2)
  branchName!: string;

  @ApiPropertyOptional({ example: 'Jl. Raya Serpong, Tangerang' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+622112345678' })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  /**
   * v1 is single-timezone (ADR-0016), so this accepts exactly one value.
   *
   * The field is kept rather than deleted for two reasons. `forbidNonWhitelisted` is on,
   * so removing it would turn a request that works today into a 400 for anybody still
   * sending it — including a reader copying the example out of Swagger. And the OpenAPI
   * document is where an integrator learns the constraint: `enum: ["Asia/Jakarta"]`
   * teaches that a zone exists and is fixed, where an absent field teaches nothing.
   *
   * Before this, `@IsString()` meant `{"timezone":"banana"}` returned 201 and every day
   * boundary in that office resolved to an Invalid DateTime, for ever, with nothing
   * raised at creation.
   */
  @ApiPropertyOptional({
    example: DEFAULT_TENANT_TIMEZONE,
    enum: [DEFAULT_TENANT_TIMEZONE],
    description:
      'v1 runs on a single time zone. Asia/Jakarta is the only accepted value; omit it ' +
      'and the office inherits the same value from its company (ADR-0016).',
  })
  @IsOptional()
  @IsIn([DEFAULT_TENANT_TIMEZONE], { message: field(SAY.timezoneOnly({ zone: DEFAULT_TENANT_TIMEZONE })) })
  timezone?: string;

  /**
   * **Start from** (ADR-0115 §4): one of the company's active templates, the Template library's, or
   * *Empty*. Absent, the company's default template — what approving a KPM request uses. The AgencyBoost
   * defaults are refused by the route (ADR-0168 §2; `AdminController.createTenant`).
   */
  @ApiPropertyOptional({
    type: () => StartFromDto,
    description:
      'What the office is built from. Absent: the company\u2019s default template. A kind the source '
      + 'holds none of is empty in the office; every office has the three cascade activity types.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StartFromDto)
  startFrom?: StartFromDto;

  @ApiPropertyOptional({
    type: () => OwnerInputDto,
    description: '***Pemilik KPM*** (ADR-0212 §1): made the KPM\u2019s Owner as one unit with it — a refusal of the Owner '
      + 'leaves no KPM. Absent (*"Lewati, nanti saja"*): a KPM with no Owner, under *Perlu perhatian Anda*.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnerInputDto)
  owner?: OwnerInputDto;

  @ApiPropertyOptional({
    default: true,
    description: '*"Kirim undangan … sekarang"*: email the Owner a one-time link to choose a password, alive for '
      + '`ROSTER_INVITATION.TTL_DAYS`. Only an Owner with an account who has never signed in is sent one.',
  })
  @IsOptional()
  @IsBoolean()
  sendInvitation?: boolean;
}

export class AssignOwnerDto {
  @ApiPropertyOptional({
    example: 'owner@kpm0417.test',
    description:
      'The account to make Owner. It must already exist — create one at /register or ' +
      'with POST /auth/register. Email is what a Super Admin normally knows.',
  })
  @IsOptional()
  // Trimmed before validation, not after. The service normalises too, but @IsEmail
  // runs first and rejects a pasted address with surrounding whitespace — so the
  // service's own trim never got the chance, and a service test passed against a
  // contract HTTP did not honour.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    description: 'Alternative to email, for when you already have the id.',
  })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    type: () => OwnerInputDto,
    description: '*Ganti pemilik* to somebody named here (ADR-0212 §3): `owner.email` required. An account with it is '
      + 'made the Owner under the same refusals; with none, an account is made for it and the Owner invited. Instead '
      + 'of `email`/`userId`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnerInputDto)
  owner?: OwnerInputDto;

  @ApiPropertyOptional({
    default: true,
    description: 'With `owner`: email the new Owner their invitation (an account that has signed in is sent none).',
  })
  @IsOptional()
  @IsBoolean()
  sendInvitation?: boolean;
}

export class SetStatusDto {
  @ApiProperty({ enum: ['active', 'suspended', 'archived'] })
  @IsEnum(['active', 'suspended', 'archived'])
  status!: 'active' | 'suspended' | 'archived';

  @ApiPropertyOptional({ example: 'unpaid invoice' })
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * An office's subscription, **all five fields every time** (ADR-0112, P13.2-T3 AC-1).
 *
 * Each field is required and every one but *keep active* may be `null`: the dialog always sends the
 * whole subscription, so a field left out is a client defect, not "unchanged". `ValidateIf` skips a
 * `null` and runs on anything else, `undefined` included, so an absent field is refused by name.
 * What one field says about another — dates both or neither, the end on or after the start, a date
 * that is a real day — is `validateSubscription`'s, in the service.
 */
export class UpdateSubscriptionDto {
  @ApiProperty({
    type: String, nullable: true, example: '2026-10-01', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'The first day, an office date (YYYY-MM-DD in the office\'s timezone). Null with endDate for no dates.',
  })
  @ValidateIf((o: UpdateSubscriptionDto) => o.startDate !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.startDateShape) })
  startDate!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2027-09-30', pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description:
      'The last day the office can be used, an office date. From 00:00 the next office day every member '
      + 'is refused TENANT_SUBSCRIPTION_ENDED unless keepActiveAfterEnd is on. On or after startDate.',
  })
  @ValidateIf((o: UpdateSubscriptionDto) => o.endDate !== null)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.endDateShape) })
  endDate!: string | null;

  @ApiProperty({
    type: Number, nullable: true, example: 350_000_00, minimum: 0, maximum: SUBSCRIPTION.PRICE_PER_LEADER_MAX_MINOR,
    description:
      'Price per leader per month, in IDR minor units (sen), whole rupiah. Informational: nothing is charged from it.',
  })
  /*
   * **The type here, the bounds in `validateSubscription`** (P13.2 exit review). `@Min`/`@Max` ran
   * before the service and answered *"pricePerLeaderMinor must not be greater than 10000000000"* — sen,
   * a field name and no `details.field` — which the dialog could not put under its field. The service
   * owns them now, in rupiah and with the field named.
   */
  @ValidateIf((o: UpdateSubscriptionDto) => o.pricePerLeaderMinor !== null)
  @IsInt()
  pricePerLeaderMinor!: number | null;

  @ApiProperty({
    type: Number, nullable: true, example: 10,
    minimum: SUBSCRIPTION.MAX_LEADERS_MIN, maximum: SUBSCRIPTION.MAX_LEADERS_MAX,
    description:
      'The most leaders (active ABs and AABs, the Owner included) the office may have. Null for no limit. '
      + 'May be set below the leaders it has now: nobody is demoted, new ones are refused.',
  })
  // The type here, the bounds in `validateSubscription`, as the price's are.
  @ValidateIf((o: UpdateSubscriptionDto) => o.maxLeaders !== null)
  @IsInt()
  maxLeaders!: number | null;

  @ApiProperty({
    example: false,
    description: 'On, and the office stays open after its end date (Ended — kept active). Never null.',
  })
  @IsBoolean()
  keepActiveAfterEnd!: boolean;

  @ApiProperty({
    required: false, nullable: true, enum: SUBSCRIPTION_PLANS, example: 'annual',
    description:
      '*Paket* (ADR-0211 §1): `six_months` (*6 bulan*) or `annual` (*Tahunan*), a label — nothing renews '
      + 'or is charged from it. `null` clears it; **absent keeps the plan the office has**, so a client sending the '
      + 'five fields alone changes no plan. Audited with the other fields.',
  })
  // The type here; an unknown value is `validateSubscription`'s, named under its field.
  @IsOptional()
  @IsString()
  plan?: SubscriptionPlan | null;
}

/**
 * The office code, supplied by the platform when a request is approved.
 *
 * Not by the requester: it must be unique within the company, and nobody outside the
 * platform can know what is free. The prototype's `KPM name` column is a branch name for
 * exactly that reason.
 */
export class ApproveKpmRequestDto {
  @ApiProperty({ example: '0629', description: 'Unique within the company.' })
  @IsString()
  @Matches(/^\d{4}$/, { message: field(SAY.kpmCodeShape) })
  code!: string;

  @ApiPropertyOptional({
    example: '65b1f0c2a4d3e5f6a7b8c9d0',
    description:
      'The company the office is for, when the Super Admin corrects it on the card (ADR-0191 §2). Absent, '
      + 'the request\'s. The applicant must belong to it: `409 TENANT_COMPANY_MISMATCH` otherwise, before anything is '
      + 'written.',
  })
  @IsOptional()
  @IsMongoId()
  companyId?: string;

  @ApiPropertyOptional({
    type: () => StartFromDto,
    description:
      '*Mulai dari* (ADR-0213 §3): what the office starts from, offered on the card when the company has **no template** '
      + 'yet — a built-in template (`{ kind: "template", templateLibrary: true, templateId? }`) or *Kosong* (`{ kind: '
      + '"empty" }`). Absent: the company\'s default template, or the built-in default where it has none. `defaults` is '
      + 'refused `400`, as on `POST /admin/tenants`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => StartFromDto)
  startFrom?: StartFromDto;
}

export class DeclineKpmRequestDto {
  @ApiPropertyOptional({
    example: 'This branch already trades under KPM 0417.',
    description: 'Kept, and sent back to whoever asked. A refusal with nothing to act on is not an answer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Somebody with no office asking for one. */
export class CreateKpmRequestDto {
  @ApiPropertyOptional({
    example: '65b1f0c2a4d3e5f6a7b8c9d0',
    description:
      'Only for an account that signed up with no company (ADR-0191 §1). Otherwise the request is for the '
      + 'company the applicant signed up with, and naming another is `409 TENANT_COMPANY_MISMATCH`.',
  })
  @IsOptional()
  @IsMongoId()
  companyId?: string;

  @ApiProperty({ example: 'Surabaya Branch' })
  @IsString()
  @MaxLength(120)
  branchName!: string;

  @ApiPropertyOptional({ example: 'We have twelve agents already working this area.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * `GET /admin/tenants/code-availability`: the company and the code being typed. The code's shape is the
 * one *New office* takes; an approval narrows it to four digits.
 */
export class CodeAvailabilityQueryDto {
  @ApiProperty({ example: '65b1f0c2a4d3e5f6a7b8c9d0' })
  @IsMongoId()
  companyId!: string;

  @ApiProperty({ example: '1001' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,16}$/)
  code!: string;
}

/** `GET /admin/accounts?q=`: part of a name or an email address, at least two characters. */
export class AccountSearchQueryDto {
  @ApiProperty({ example: 'victor' })
  @IsString()
  @MaxLength(100)
  q!: string;
}

/** *Pindahkan ke perusahaan lain* (ADR-0191 §5). */
export class MoveCompanyDto {
  @ApiProperty({ example: '65b1f0c2a4d3e5f6a7b8c9d0', description: 'The insurer the office moves to.' })
  @IsMongoId()
  companyId!: string;
}

/**
 * The roster, as text: **the paste**.
 *
 * Named `rows` rather than `csv` because it is not always CSV: it is the **tab-separated**
 * text a spreadsheet puts on the clipboard when somebody copies cells, or a CSV's. One
 * field, because the parser decides the delimiter from the first line and neither the
 * caller nor the reader gains from saying which it is.
 *
 * Sent as JSON, because a paste is not a file. **A file is sent as one since ADR-0184** —
 * `roster/file/preview` and `roster/file`, `multipart/form-data`, a workbook or a CSV read
 * on the server — and reaches the same parser as this text. The cap is
 * `ROSTER_UPLOAD.MAX_TEXT_LENGTH`, 512,000 characters: a roster of tens of thousands and
 * far past the 500-member office ceiling `performance-and-scale.md` sets.
 */
/**
 * **`GET /admin/tenants/roster-template`'s query** (S4 of the T17–T20 permission review). `kpmId` reaches a lookup by
 * id, so it is an ObjectId or nothing — `?kpmId[$ne]=…` is a 400, never an operator handed to the database — and
 * `format` is one of the two files the template comes in, or absent for the JSON.
 */
export class RosterTemplateQueryDto {
  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], description: 'Absent: the JSON. `xlsx` or `csv`: the template as that file.' })
  @IsOptional()
  @IsIn(['xlsx', 'csv'], { message: field(SAY.unknownTemplateFormat) })
  format?: 'xlsx' | 'csv';

  @ApiPropertyOptional({ description: 'The office whose ladder fills the `role` dropdown (xlsx only). Another office’s is 404.' })
  @IsOptional()
  @IsMongoId()
  kpmId?: string;
}

export class RosterRowsDto {
  @ApiProperty({
    description:
      'The rows, as text. Tab-separated from a spreadsheet paste, or comma-separated. '
      + 'The header row is optional. A file is sent to `roster/file/preview` and `roster/file`.',
    maxLength: ROSTER_UPLOAD.MAX_TEXT_LENGTH,
  })
  @IsString()
  @MaxLength(ROSTER_UPLOAD.MAX_TEXT_LENGTH)
  rows!: string;
}

/**
 * **The pasted rows, imported** (P19.3-T4; ADR-0205 §10): the rows, and whether to mail each new person an invitation
 * to choose their password. Absent is `true` — A3's checkbox is on by default.
 */
export class RosterImportDto extends RosterRowsDto {
  @ApiPropertyOptional({
    type: Boolean, default: true,
    description: 'Mail each new person a one-time link to choose their password (email only, ADR-0010). Default `true`.',
  })
  @IsOptional()
  @IsBoolean()
  invite?: boolean;
}

/**
 * **The file's form fields, on `roster/file`** (P19.3-T4): `invite` beside `file`, as the form's text — `true` or
 * `false`. Absent is `true`.
 */
export class RosterFileImportDto {
  @ApiPropertyOptional({ enum: ['true', 'false'], default: 'true', description: 'As `RosterImportDto.invite`, as form text.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  invite?: 'true' | 'false';
}


/**
 * The office's own identity (P4-T5, `KPM_Owner.html:1807-1812`).
 *
 * **No company and no owner.** The prototype disables both fields and labels the first
 * *"tagged by Superadmin"* — that is where the platform-owned boundary was first written
 * down, and `kpm:update_company_tag` is Super Admin's alone.
 *
 * **No locale, timezone or currency.** ADR-0016 fixes all three for v1 and no screen
 * offers them.
 */
export class UpdateBranchInfoDto {
  @ApiPropertyOptional({ example: 'BSD City Branch', minLength: 2, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  branchName?: string;

  @ApiPropertyOptional({ example: 'Jl. BSD Grand Boulevard No. 1, Tangerang', maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  address?: string;

  @ApiPropertyOptional({ example: '+62 21 5555 0417', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    maximum: 12,
    description: 'The month the financial year starts. Stored now; no computation reads it yet.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  fiscalYearStartMonth?: number;
}
