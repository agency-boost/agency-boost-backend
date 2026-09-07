import { ApiProperty } from '@nestjs/swagger';
import type {
  AttentionItem, CompanyCard, KpmView, PlatformAdminRow, PlatformOverview,
} from './tenant.service';
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

  @ApiProperty({ enum: ['active', 'archived'], type: String })
  status!: 'active' | 'archived';

  @ApiProperty({ type: String, nullable: true })
  archivedAt!: string | null;

}

