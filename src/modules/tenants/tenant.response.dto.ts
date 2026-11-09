import { ApiProperty } from '@nestjs/swagger';
import type {
  AccountChoice, AccountOffice, AttentionItem, CompanyCard, KpmAdminView, KpmCreated, KpmView, OwnerState, PlatformAdminRow,
  PlatformOverview,
} from './tenant.service';
import type { KpmPendingOwner, KpmSubscription } from './kpm.schema';
import type { SubscriptionState } from './subscription';
import type { KpmRequestRow, MyKpmRequestState } from './kpm-request.service';
import type { KpmRequestStatus } from './kpm-request.schema';
import type { OrgLevelRow } from './org-level.service';
import type { KpmDataStatus } from '@/modules/reporting/platform/platform-reads.service';

/**
 * The response shapes of the platform console, as documented classes.
 *
 * **Each one `implements` the interface the service actually returns.** That is the whole
 * point: TypeScript refuses to compile a class that has drifted from its interface, so a
 * field added to a service and forgotten here is a build failure rather than a silent
 * hole in the contract. Interfaces alone cannot do this job — they are erased before
 * Swagger runs, which is why 0 of 69 operations documented a response body until
 * P3.1-T11.
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

/** An Owner named with no email (ADR-0212 §3). */
export class KpmPendingOwnerDto implements KpmPendingOwner {
  @ApiProperty({ type: String, example: 'Wulan Kartika' })
  fullName!: string;

  @ApiProperty({ type: String, example: '+6281277006020' })
  phone!: string;

  @ApiProperty({ type: String, nullable: true, example: '70045001' })
  agentCode!: string | null;
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

  @ApiProperty({
    type: String, nullable: true, required: false, enum: ['six_months', 'annual'],
    description: '*Paket* (ADR-0211 §1): *6 bulan* or *Tahunan*; null or absent, none. Its renewal date is `endDate`.',
  })
  plan?: 'six_months' | 'annual' | null;
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

  @ApiProperty({
    type: String, enum: ['none', 'not_invited', 'invited', 'active'],
    description:
      'The Owner\'s state (ADR-0212 §2, §3): none — no Owner and none named; not_invited — *Belum diundang*, never '
      + 'sent an invitation or named with no email (`pendingOwner`); invited — *Diundang*, the latest invitation sent '
      + 'and never signed in; active — *Aktif*, the Owner\'s account has signed in.',
  })
  ownerState!: OwnerState;

  @ApiProperty({
    type: String, nullable: true, example: '+6281277006020',
    description: 'The Owner\'s WhatsApp number — the account\'s, or the pending Owner\'s. A number to call; nothing is sent by it.',
  })
  ownerPhone!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When the Owner\'s latest invitation was sent.' })
  ownerInvitedAt!: string | null;

  @ApiProperty({
    type: KpmPendingOwnerDto, nullable: true,
    description: 'The Owner named with no email, waiting until *Ganti pemilik* gives one (ADR-0212 §3). Super Admin only.',
  })
  pendingOwner!: KpmPendingOwnerDto | null;

  @ApiProperty({ type: Number, description: 'Live memberships — active and pending — the Owner\'s own included.' })
  memberCount!: number;

  @ApiProperty({ type: Number, description: 'The same without the Owner\'s own: *"Belum ada anggota"* while 0 (SA R5).' })
  membersBesidesOwner!: number;
}

class KpmAdminPersonDto {
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ['active', 'invited', 'not_invited'], description: '*Aktif · Diundang · Belum diundang* (ADR-0212 §2).' })
  state!: 'active' | 'invited' | 'not_invited';
}

class KpmRungCountDto {
  @ApiProperty({ example: 'AB' }) code!: string;
  @ApiProperty({ example: 'Agency Builder' }) label!: string;
  @ApiProperty() count!: number;
}

/**
 * `GET /admin/tenants/:id` as the Super Admin reads it (P19.4-T3 AC-9): the admin view, the KPM's Admins read-only and its
 * live members by rung — *Ringkasan*'s cards. An Owner's or an Admin's read of their own office carries neither.
 */
export class KpmProfileDto extends KpmAdminViewDto {
  @ApiProperty({ type: [KpmAdminPersonDto], required: false, description: 'The delegated Admins, the Owner left out.' })
  admins?: KpmAdminPersonDto[];

  @ApiProperty({ type: [KpmRungCountDto], required: false, description: 'Live members, active or pending, by rung.' })
  membersByRole?: KpmRungCountDto[];
}

/** *Data terakhir* and *Perlu tindakan* (P19.4-T3 AC-8): whether the office's months are uploaded, never a figure. */
class KpmDataStatusDto implements KpmDataStatus {
  @ApiProperty({ type: String, nullable: true, example: '2026-10', description: 'The latest month the office’s file holds.' })
  latestMonth!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '2026-10',
    description: 'The last ended month when it is not uploaded and the office existed in it: *"Data <bulan> belum diunggah"*.',
  })
  missingMonth!: string | null;
}

/** A row of `GET /admin/tenants`: the admin view, and its data status (P19.4-T3 AC-8). */
export class KpmListRowDto extends KpmAdminViewDto {
  @ApiProperty({ type: KpmDataStatusDto })
  dataStatus!: KpmDataStatusDto;
}

/** `POST /admin/tenants`'s answer: the KPM, and whether its Owner's invitation went (ADR-0212 §2). */
export class KpmCreatedDto extends KpmViewDto implements KpmCreated {
  @ApiProperty({
    type: Boolean,
    description: 'True once the Owner\'s invitation email is on its way; false with no Owner, no email, *Kirim '
      + 'undangan* unticked, an Owner who has signed in, or a send that failed (logged; the KPM stands).',
  })
  invitationSent!: boolean;
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

  @ApiProperty({ type: String, nullable: true, description: 'The applicant\'s number as they gave it.' })
  requestedByPhone!: string | null;

  @ApiProperty({
    type: String, nullable: true,
    description: 'The company the applicant signed up with (ADR-0191 §1); `null` for an account with none.',
  })
  requesterCompanyId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  requesterCompanyName!: string | null;

  @ApiProperty({ type: Boolean, description: 'Only a verified address may own an office (ADR-0190 §4).' })
  requesterEmailVerified!: boolean;

  @ApiProperty({ type: () => CreatedKpmDto, nullable: true, description: 'What an approved request made.' })
  createdKpm!: { kpmId: string; code: string; branchName: string; deleted: boolean } | null;

}

/** The office an approved request made; `deleted` once it has since been deleted. */
export class CreatedKpmDto {
  @ApiProperty({ type: String }) kpmId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) branchName!: string;
  @ApiProperty({ type: Boolean }) deleted!: boolean;
}

/** The company a reader signed up with, named. */
export class OwnCompanyDto {
  @ApiProperty({ type: String }) companyId!: string;
  @ApiProperty({ type: String }) name!: string;
}

/** `GET /join/kpm-request` (ADR-0191 §1): the reader's request, and the company one is for. */
export class MyKpmRequestStateDto implements MyKpmRequestState {
  @ApiProperty({ type: () => KpmRequestRowDto, nullable: true })
  request!: KpmRequestRow | null;

  @ApiProperty({
    type: () => OwnCompanyDto, nullable: true,
    description: 'The company the reader signed up with; `null` for an account with none — the form then asks for one.',
  })
  company!: { companyId: string; name: string } | null;
}

/** An office an account owns or belongs to. */
export class AccountOfficeDto implements AccountOffice {
  @ApiProperty({ type: String }) kpmId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) branchName!: string;
  @ApiProperty({ type: String }) companyName!: string;
  @ApiProperty({ type: Boolean }) isOwner!: boolean;
  @ApiProperty({ type: String, enum: ['active', 'pending'], nullable: true })
  membershipStatus!: 'active' | 'pending' | null;
}

/** One account *Ganti Owner* may choose (`GET /admin/accounts`). */
export class AccountChoiceDto implements AccountChoice {
  @ApiProperty({ type: String }) userId!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty({ type: String }) email!: string;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) companyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) companyName!: string | null;
  @ApiProperty({ type: Boolean }) hasAgentCode!: boolean;
  @ApiProperty({ type: Boolean }) emailVerified!: boolean;
  @ApiProperty({ type: String, enum: ['invited', 'active', 'deactivated'] })
  status!: 'invited' | 'active' | 'deactivated';
  @ApiProperty({ type: () => AccountOfficeDto, isArray: true }) offices!: AccountOffice[];
}

/** The live office holding a code. */
export class CodeHolderDto {
  @ApiProperty({ type: String }) kpmId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) branchName!: string;
  @ApiProperty({ type: String }) companyName!: string;
}

/** `GET /admin/tenants/code-availability`. */
export class CodeAvailabilityDto {
  @ApiProperty({ type: Boolean }) available!: boolean;
  @ApiProperty({ type: () => CodeHolderDto, nullable: true })
  takenBy!: { kpmId: string; code: string; branchName: string; companyName: string } | null;
}

/** `GET /admin/tenants/:id/contents`: what the *Hapus KPM* confirmation shows. */
export class KpmContentsDto {
  @ApiProperty({ type: Number, description: 'Every membership, whatever its state, the Owner\'s included.' })
  members!: number;

  @ApiProperty({ type: Number, description: 'Every row carrying the office, apart from its configuration and the audit log.' })
  records!: number;

  @ApiProperty({ type: Boolean }) deletable!: boolean;
}

/** `DELETE /admin/tenants/:id`. */
export class KpmDeletedDto {
  @ApiProperty({ type: Boolean, enum: [true] }) deleted!: true;
  @ApiProperty({ type: String }) kpmId!: string;
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

  @ApiProperty({
    type: Number,
    example: 0,
    description: '`0` for a rung never changed; moves on every write of it. Send it back as `expectedVersion` on '
      + '`PATCH /admin/org-levels/:id`.',
  })
  version!: number;

}


/** The member template's header row, so a client can offer the download. */
export class RosterTemplateDto {
  @ApiProperty({
    type: String,
    example: 'Kode agen,Nama,Peran,Kode upline,No. WhatsApp,Email,Tanggal bergabung,Waktu,Tanggal lahir,Jenis kelamin,'
      + 'Bulan bergabung di perusahaan',
    description: 'A3\'s nine columns, then the two other demographic columns (ADR-0205 §5). Only *Kode agen*, '
      + '*Nama* and *Peran* are required; today\'s English names are read as aliases, so an old file still imports.',
  })
  header!: string;

  @ApiProperty({ type: [String] })
  columns!: string[];

  /** The CSV template: **the header and nothing else** since ADR-0184. */
  @ApiProperty({ type: String })
  template!: string;

  /** Three worked rows, as cells: what the paste box shows, tab-joined, and the workbook's guide lists. */
  @ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'string' } } })
  examples!: string[][];
}

/** What makes a member file unreadable as a whole. */
export class RosterIssueDto {
  @ApiProperty({ type: Number, description: 'The line a spreadsheet shows, header counted.' })
  line!: number;

  @ApiProperty({ type: String, description: '`file`, or the column\'s header name.' })
  column!: string;

  @ApiProperty({ type: String })
  message!: string;
}

/** One row of a member file and what it comes to (A3). */
export class RosterPreviewRowDto {
  @ApiProperty({ type: Number })
  line!: number;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String, description: 'The rung as the file names it.' })
  role!: string;

  @ApiProperty({ type: String, description: 'The upline\'s agent code; empty for none.' })
  leaderAgentCode!: string;

  @ApiProperty({ type: String, description: 'Empty when the row gives none.' })
  email!: string;

  @ApiProperty({ enum: ['imported', 'updated', 'skipped'] })
  outcome!: 'imported' | 'updated' | 'skipped';

  @ApiProperty({
    type: [String],
    description: 'A3\'s words for the row, in the reader\'s language: why it is skipped, or what importing or updating it notes.',
  })
  messages!: string[];
}

export class RosterCountsDto {
  @ApiProperty({ type: Number })
  imported!: number;

  @ApiProperty({ type: Number })
  updated!: number;

  @ApiProperty({ type: Number })
  skipped!: number;
}

export class RosterPreviewDto {
  @ApiProperty({ type: RosterIssueDto, isArray: true, description: 'Only what makes the file unreadable; `rows` is then empty.' })
  issues!: RosterIssueDto[];

  @ApiProperty({ type: [String], description: 'The file\'s header, as it reads.' })
  header!: string[];

  @ApiProperty({ type: RosterCountsDto })
  counts!: RosterCountsDto;

  @ApiProperty({ type: RosterPreviewRowDto, isArray: true })
  rows!: RosterPreviewRowDto[];

  @ApiProperty({
    type: String, nullable: true,
    description: 'The skipped rows as a CSV: the file\'s columns and `Alasan`, in the file\'s order. `null` when none.',
  })
  skippedCsv!: string | null;
}

/** What the commit did: the same rows, now done. **No password**: new people are invited to choose their own. */
export class RosterCommitDto extends RosterPreviewDto {
  @ApiProperty({ type: Number, description: 'How many new people were emailed an invitation.' })
  invited!: number;
}
