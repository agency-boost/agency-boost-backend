import { ApiProperty } from '@nestjs/swagger';
import type {
  AttentionItem, CompanyCard, KpmAdminView, KpmView, PlatformAdminRow, PlatformOverview,
} from './tenant.service';
import type { KpmSubscription } from './kpm.schema';
import type { SubscriptionState } from './subscription';
import type { KpmRequestRow } from './kpm-request.service';
import type { KpmRequestStatus } from './kpm-request.schema';
import type { OrgLevelRow } from './org-level.service';

/**
 * The response shapes of the platform console, as documented classes.
 *
 * **Each one `implements` the interface the service actually returns.** That is the whole
 * point: TypeScript refuses to compile a class that has drifted from its interface, so a
 * field added to a service and forgotten here is a build failure rather than a silent
 * hole in the contract. Interfaces alone cannot do this job — they are erased before
 * Swagger runs, which is why 0 of 69 operations documented a response body until
 * P3.5-T11.
 */
export class KpmViewDto implements KpmView {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String })
  companyName!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  branchName!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ownerUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ownerName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ownerEmail!: string | null;

  @ApiProperty({ type: String })
  timezone!: string;

  @ApiProperty({ type: String })
  locale!: string;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({
    type: Number,
    example: 1,
    description:
      'The month the office\'s financial year starts, 1–12. Stored and shown now; '
      + 'no period computation reads it yet.',
  })
  fiscalYearStartMonth!: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  settings!: Record<string, number>;

  @ApiProperty({ enum: ['active', 'suspended', 'archived'], type: String })
  status!: 'active' | 'suspended' | 'archived';

  @ApiProperty({ type: String, nullable: true })
  suspendedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  suspendedReason!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

}

/** An office's subscription, as stored (ADR-0112 §1). */
export class KpmSubscriptionDto implements KpmSubscription {
  @ApiProperty({ type: String, nullable: true, example: '2026-10-01', description: 'An office date, YYYY-MM-DD.' })
  startDate!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2027-09-30',
    description: 'The last day the office can be used, an office date. Ended from the next office day.',
  })
  endDate!: string | null;

  @ApiProperty({
    type: Number, nullable: true, example: 350_000_00,
    description: 'Per leader per month, IDR minor units (sen). Informational: nothing is charged from it.',
  })
  pricePerLeaderMinor!: number | null;

  @ApiProperty({ type: String, enum: ['IDR'] })
  currency!: 'IDR';

  @ApiProperty({ type: Number, nullable: true, example: 10, description: 'Null for no leader limit.' })
  maxLeaders!: number | null;

  @ApiProperty({ type: Boolean })
  keepActiveAfterEnd!: boolean;
}

/**
 * An office as the Super Admin's offices list and detail read it (P13.2-T3 AC-3): the office, its
 * subscription, *Leaders used* and where it stands against its end date.
 *
 * `GET /admin/tenants/:id` answers this shape to the Super Admin only; an Owner or an Admin reading
 * their own office there is answered without the three fields, as `KpmViewDto`.
 */
export class KpmAdminViewDto extends KpmViewDto implements KpmAdminView {
  @ApiProperty({ type: KpmSubscriptionDto, nullable: true, description: 'Null: no subscription, no end and no limit.' })
  subscription!: KpmSubscriptionDto | null;

  @ApiProperty({
    type: Number, example: 6,
    description: 'Leaders used (ADR-0113): active members at AB or AAB, the Owner and an Admin included.',
  })
  leadersUsed!: number;

  @ApiProperty({
    type: String, enum: ['none', 'active', 'ended', 'ended_kept_active'],
    description:
      'Against the office\'s today: none (no end date), active (the end is today or later), ended (past it, '
      + 'members refused) or ended_kept_active (past it, kept active).',
  })
  subscriptionState!: SubscriptionState;
}

export class PlatformAdminRowDto implements PlatformAdminRow {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({ type: String })
  kpmLabel!: string;

  @ApiProperty({ type: Boolean })
  isOwner!: boolean;

  @ApiProperty({ type: Boolean })
  isAdmin!: boolean;

  @ApiProperty({ type: String, nullable: true })
  grantedAt!: string | null;

}

export class AttentionItemDto implements AttentionItem {
  @ApiProperty({ type: String })
  tag!: string;

  @ApiProperty({ enum: ['structural', 'approval', 'template'], type: String })
  severity!: 'structural' | 'approval' | 'template';

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  detail!: string;

  @ApiProperty({ type: String })
  href!: string;

  @ApiProperty({ type: String })
  actionLabel!: string;

}

export class CompanyCardDto implements CompanyCard {
  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  initials!: string;

  @ApiProperty({ type: Number })
  kpmCount!: number;

  @ApiProperty({ type: Number })
  memberCount!: number;

  @ApiProperty({ type: String, isArray: true })
  ladder!: string[];

}

/** The four headline counts, which the prototype puts *under* the queue (`:275-297`). */
export class PlatformTilesDto {
  @ApiProperty({ type: Number })
  companies!: number;

  @ApiProperty({ type: Number })
  kpms!: number;

  @ApiProperty({ type: Number, description: 'Active memberships across every office.' })
  totalMembers!: number;

  @ApiProperty({ type: Number, description: 'How many of them hold the AB rung.' })
  agencyBuilders!: number;
}

export class PlatformOverviewDto implements PlatformOverview {
  @ApiProperty({ type: () => PlatformTilesDto })
  tiles!: { companies: number; kpms: number; totalMembers: number; agencyBuilders: number };

  @ApiProperty({ type: () => AttentionItemDto, isArray: true })
  attention!: AttentionItem[];

  @ApiProperty({ type: () => CompanyCardDto, isArray: true })
  companies!: CompanyCard[];

}

export class KpmRequestRowDto implements KpmRequestRow {
  @ApiProperty({ type: String })
  requestId!: string;

  @ApiProperty({ type: String })
  branchName!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String })
  companyName!: string;

  @ApiProperty({ type: String })
  requestedByName!: string;

  @ApiProperty({ type: String })
  requestedByEmail!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, enum: ['pending', 'approved', 'declined'] })
  status!: KpmRequestStatus;

  @ApiProperty({ type: String })
  requestedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdKpmId!: string | null;

}

export class OrgLevelRowDto implements OrgLevelRow {
  @ApiProperty({ type: String })
  orgLevelId!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({
    enum: ['senior', 'associate'], type: String, nullable: true,
    description: '*Senior Leader*, *Associate Leader*, or `null` — *Not a leader* (ADR-0156).',
  })
  leaderTier!: 'senior' | 'associate' | null;

  @ApiProperty({ enum: ['active', 'archived'], type: String })
  status!: 'active' | 'archived';

  @ApiProperty({ type: String, nullable: true })
  archivedAt!: string | null;

}


/** The roster template's header row, so a client can offer the download. */
export class RosterTemplateDto {
  @ApiProperty({
    type: String,
    example: 'fullName,email,agentCode,role,leaderAgentCode,dateOfBirth,companyJoinMonth,workStatus,gender',
    description: 'Nine columns: the four a person records follow the five, each required (ADR-0158).',
  })
  header!: string;

  @ApiProperty({ type: [String] })
  columns!: string[];

  /**
   * The CSV template: **the header and nothing else** since ADR-0184. Its guide and examples were `#` lines above the
   * header until then; they are the Excel template's guide sheet (`format=xlsx`) and the page's now.
   */
  @ApiProperty({ type: String, example: 'fullName,email,agentCode,role,leaderAgentCode,dateOfBirth,companyJoinMonth,workStatus,gender\n' })
  template!: string;

  /** Three worked rows, as cells: what the paste box shows, tab-joined, and the workbook's guide lists. */
  @ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'string' } } })
  examples!: string[][];
}

export class RosterIssueDto {
  @ApiProperty({ type: Number, description: 'The line a spreadsheet shows, header counted.' })
  line!: number;

  @ApiProperty({ type: String })
  column!: string;

  @ApiProperty({ type: String })
  message!: string;
}

export class RosterPreviewRowDto {
  @ApiProperty({ type: Number })
  line!: number;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String })
  role!: string;
}

export class RosterPreviewDto {
  @ApiProperty({ type: RosterIssueDto, isArray: true })
  issues!: RosterIssueDto[];

  @ApiProperty({ type: Number, description: 'Zero whenever anything is wrong: it is all or nothing.' })
  willCreate!: number;

  @ApiProperty({ type: RosterPreviewRowDto, isArray: true })
  rows!: RosterPreviewRowDto[];
}

export class ImportedPersonDto {
  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  /**
   * **The only place this exists.** Not stored in plaintext, not in the audit row, not
   * recoverable — if the operator loses it before sending it on, the person uses
   * Forgot your password instead.
   */
  @ApiProperty({ type: String, example: 'kfmp-3xqz-7bdn-r4vw' })
  temporaryPassword!: string;
}

export class RosterCommitDto {
  @ApiProperty({ type: ImportedPersonDto, isArray: true })
  created!: ImportedPersonDto[];
}
