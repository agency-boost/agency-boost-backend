import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { DEFAULT_TENANT_TIMEZONE, normalisePhone, PLATFORM_READ, type PlatformMemberRole, type RoleClass } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { countedMembers, isCountedOffice, KELUAR, NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { UserInvitationRepository } from '@/modules/org/user-invitation.repository';
import { userInvitationStateOf } from '@/modules/org/user-invitation.schema';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { AvatarLinks } from '@/modules/users/avatar.service';
import { PLATFORM_READS_REFUSALS } from './platform-reads.messages';
import { retiredUserIds, searchOf, withoutRetired } from './platform-reads.service';

/** The audit action of one read of *Menunggu* (ADR-0207 §5), labelled in the audit log. */
const WAITING_ACTION = 'platform_read.members_waiting';

/**
 * **Anggota's three chips** (P19.28-T1 AC-5, T3 AC-4; UI-209 (21 Nov); ADR-0286 §5), each counted over the same scope
 * — the company, the KPM, the role and the search asked — test accounts never:
 *
 * - `active` — ***Aktif***: the counted member (`COUNTED_MEMBER`, 19.26's one definition, ADR-0284 §1), in a KPM that is
 *   counted;
 * - `pending` — ***Menunggu***: everybody *Menunggu* lists — an invitation of *Tambah user* not accepted (*Diundang*),
 *   and a person registered and not placed (*Belum ada KPM*);
 * - `removed` — ***Keluar***: a membership that ended (`KELUAR`).
 */
export interface AnggotaChips {
  active: number;
  pending: number;
  removed: number;
}

/**
 * **One row of *Menunggu*** (P19.28-T1 AC-5; UI-209): not a membership — two kinds of person who are not *Aktif* yet.
 *
 * - `invited` — ***Diundang · <date>***: an invitation of *Tambah user* (`userInvitations`), the KPM and rung it carries,
 *   `since` the day it was sent or last sent again; ⋯ *Kirim ulang · Batalkan* write it by `invitationId`.
 * - `unplaced` — ***Belum ada KPM***: an account with no active membership — registered to a KPM nobody placed them in
 *   (`membershipId`, a pending membership; `kpm` is the KPM they registered to, which *Masukkan* prefills, OD-441), or in
 *   no KPM at all (`kpm` `null`). `since` the day the account registered. **Its email is on the row** (ADR-0286 §5): the
 *   account is what the row is about, as *Akun terdaftar*'s rows carry it (ADR-0245 §2); never a phone.
 */
export interface WaitingRow {
  kind: 'invited' | 'unplaced';
  invitationId: string | null;
  userId: string | null;
  membershipId: string | null;
  fullName: string;
  avatarUrl: string | null;
  email: string | null;
  company: { id: string; name: string } | null;
  kpm: { id: string; code: string; branch: string } | null;
  /** The invitation's rung; `null` for somebody nobody placed. */
  role: { code: string; label: string; class: RoleClass } | null;
  /** An office date `YYYY-MM-DD`: when the invitation went (*Diundang · <date>*), or the account registered. */
  since: string;
  /** An invitation past its days: still *Diundang*, and *Kirim ulang* revives it. */
  expired: boolean;
  testAccount: boolean;
  /**
   * **Whether there is a WhatsApp number to write to** — never the number (ADR-0286 §5). An invitation always carries one;
   * an account, when its `phone` is a number `normalisePhone` reads. The screen opens WhatsApp in the tap itself only when
   * it is `true` (iPhone Safari blocks a window opened after an answer arrives); the number comes with *Masukkan*'s answer.
   */
  hasPhone: boolean;
}

export interface WaitingPage {
  rows: WaitingRow[];
  page: number;
  pageSize: number;
  total: number;
  chips: AnggotaChips;
}

export interface AnggotaScope {
  companyId?: string;
  kpmId?: string;
  role?: PlatformMemberRole;
  q?: string;
  page?: number;
  /** *Tampilkan akun tes*: test accounts listed too, each tagged — never counted (ADR-0267 §1). */
  testAccount?: 'include' | 'only';
}

/**
 * ***Menunggu*, and the chips over every status** (P19.28-T1 AC-5, T3; ADR-0286 §5): the Super Admin's read of the
 * people who are not *Aktif* yet, across KPMs — `GET /admin/waiting-members` — and the three counts both it and `GET
 * /admin/members` answer.
 *
 * Named cross-tenant reads only (invariant §1), each the Super Admin's and registered in
 * `named-cross-tenant-reads.tenancy.spec.ts`: the memberships through `listMembershipsAcrossTenants` and
 * `countPerOfficeAcrossTenants`, the invitations through `listWaitingAcrossTenants`, and whether an account holds a live
 * membership through `liveMembershipCountsPerUserAcrossTenants`. **Audited per read** (ADR-0207 §5) as
 * `platform_read.members_waiting`: one entry in the platform's log, one in each KPM's whose rows it returned; a failure
 * fails the read.
 */
@Injectable()
export class AnggotaWaiting {
  constructor(
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly memberships: MembershipRepository,
    private readonly invitations: UserInvitationRepository,
    private readonly orgLevels: OrgLevelService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Optional() @Inject(AvatarLinks) private readonly avatarLinks: AvatarLinks | null = null,
  ) {}

  private require(ctx: RequestContext): void {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, 'platform_members:read')) {
      throw new PermissionDeniedException('platform_members:read');
    }
  }

  private searchTerm(q: string | undefined): string {
    const term = q?.trim() ?? '';
    if (q !== undefined && term.length < PLATFORM_READ.SEARCH_MIN_LENGTH) {
      throw new InvalidRequestException(PLATFORM_READS_REFUSALS.VALIDATION_FAILED.searchTooShort, { field: 'q' });
    }
    return term;
  }

  private async officesFor(scope: AnggotaScope): Promise<KpmDocument[]> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (scope.companyId) filter.companyId = scope.companyId;
    if (scope.kpmId) {
      if (!isValidObjectId(scope.kpmId)) return [];
      filter._id = scope.kpmId;
    }
    return this.kpms.find(filter).sort({ code: 1 }).exec();
  }

  private async usersMatching(q: string): Promise<string[]> {
    const rows = await this.users.find({ $or: searchOf(q, { phone: true }) }).select('_id').lean().exec();
    return rows.map((u) => String(u._id));
  }

  /** **The three chips**, over the scope asked (`AnggotaChips`). `active` is 19.26's counted member, never recounted. */
  async chips(ctx: RequestContext, scope: AnggotaScope): Promise<AnggotaChips> {
    this.require(ctx);
    const q = this.searchTerm(scope.q);
    const offices = await this.officesFor(scope);
    const matching = q ? await this.usersMatching(q) : null;
    return this.countChips(ctx, offices, scope, q, matching);
  }

  private async countChips(
    ctx: RequestContext, offices: KpmDocument[], scope: AnggotaScope, q: string, matching: string[] | null,
  ): Promise<AnggotaChips> {
    const narrow: Record<string, unknown> = {};
    if (scope.role) narrow.role = scope.role;
    // A retired account is counted in no chip (P19.31; OD-487), as it is listed in none.
    narrow.userId = withoutRetired(matching, await retiredUserIds(this.users));
    const counted = offices.filter((k) => isCountedOffice(k)).map((k) => String(k._id));
    const [active, removed, waiting] = await Promise.all([
      this.memberships.countPerOfficeAcrossTenants(ctx, counted, countedMembers(narrow)),
      this.memberships.countPerOfficeAcrossTenants(ctx, offices.map((k) => String(k._id)), { ...narrow, ...KELUAR }),
      this.collect(ctx, offices, { ...scope, testAccount: undefined }, q, matching),
    ]);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    return { active: sum(active), pending: waiting.length, removed: sum(removed) };
  }

  /** ***Menunggu*'s page** (`GET /admin/waiting-members`): by name, 50 a page, with the chips. Audited. */
  async page(ctx: RequestContext, scope: AnggotaScope): Promise<WaitingPage> {
    this.require(ctx);
    const page = scope.page ?? 1;
    const q = this.searchTerm(scope.q);
    const offices = await this.officesFor(scope);
    const matching = q ? await this.usersMatching(q) : null;
    const [all, chips] = await Promise.all([
      this.collect(ctx, offices, scope, q, matching),
      this.countChips(ctx, offices, scope, q, matching),
    ]);
    const sorted = all.sort((a, b) => a.fullName.localeCompare(b.fullName)
      || (a.invitationId ?? a.membershipId ?? a.userId ?? '').localeCompare(b.invitationId ?? b.membershipId ?? b.userId ?? ''));
    const rows = sorted.slice((page - 1) * PLATFORM_READ.PAGE_SIZE, page * PLATFORM_READ.PAGE_SIZE);
    await this.withPhotos(rows);

    const byKpm = new Map<string, number>();
    for (const r of rows) if (r.kpm) byKpm.set(r.kpm.id, (byKpm.get(r.kpm.id) ?? 0) + 1);
    const filters = {
      companyId: scope.companyId ?? null, kpmId: scope.kpmId ?? null, role: scope.role ?? null, q: q || null,
      testAccount: scope.testAccount ?? null,
    };
    await this.audit.recordInScopesOrFail(ctx, [
      {
        kpmId: null,
        entry: {
          action: WAITING_ACTION,
          targetCollection: 'memberships',
          targetId: null,
          after: {
            purpose: PLATFORM_READ.PURPOSE.members, filters, page, rows: rows.length,
            invitationIds: rows.flatMap((r) => (r.invitationId ? [r.invitationId] : [])),
            userIds: rows.flatMap((r) => (r.kind === 'unplaced' && r.userId ? [r.userId] : [])),
          },
        },
      },
      ...[...byKpm].map(([kpmId, n]) => ({
        kpmId,
        entry: {
          action: WAITING_ACTION, targetCollection: 'kpms', targetId: kpmId,
          after: { purpose: PLATFORM_READ.PURPOSE.members, rows: n, ...filters },
        },
      })),
    ]);
    return { rows, page, pageSize: PLATFORM_READ.PAGE_SIZE, total: all.length, chips };
  }

  /** Each row's photo as a signed link, signed once per key; none, the initials. */
  private async withPhotos(rows: WaitingRow[]): Promise<void> {
    const ids = rows.flatMap((r) => (r.userId && isValidObjectId(r.userId) ? [r.userId] : []));
    if (!this.avatarLinks || ids.length === 0) return;
    const keys = await this.users.find({ _id: { $in: ids } }).select('avatarUrl').lean().exec() as { _id: unknown; avatarUrl?: string | null }[];
    const keyOf = new Map(keys.map((k) => [String(k._id), k.avatarUrl ?? null]));
    const links = await this.avatarLinks.linksFor([...keyOf.values()]);
    for (const r of rows) {
      const key = r.userId ? keyOf.get(r.userId) ?? null : null;
      r.avatarUrl = key ? links.get(key) ?? null : null;
    }
  }

  /**
   * **Everybody *Menunggu* lists, in the scope** — invitations waiting, pending memberships, and accounts in no KPM — one
   * person once: an account an invitation names reads *Diundang*, and somebody who left a KPM is under *Keluar*, not
   * here. A role or a KPM asked leaves out the accounts in no KPM, which have neither.
   */
  private async collect(
    ctx: RequestContext, offices: KpmDocument[], scope: AnggotaScope, q: string, matching: string[] | null,
  ): Promise<WaitingRow[]> {
    const kpmIds = offices.map((k) => String(k._id));
    const byOffice = new Map(offices.map((k) => [String(k._id), k]));
    const companyIds = [...new Set(offices.map((k) => k.companyId))];
    const now = this.clock.now();
    const testClause = scope.testAccount === 'only' ? { testAccount: true }
      : scope.testAccount === 'include' ? {} : NOT_A_TEST_ACCOUNT;

    // 1. *Tambah user*'s invitations, waiting (expired included: they read *Diundang* until resent or cancelled).
    const invited = scope.testAccount === 'only' ? [] : (await this.invitations.listWaitingAcrossTenants(
      ctx, kpmIds, scope.role ? { roleClass: scope.role } : {},
    )).filter((inv) => !q || matchesInvitation(inv, q, matching));

    // 2. Pending memberships: registered to a KPM, nobody placed them.
    const pendingFilter: Record<string, unknown> = { status: 'pending', ...testClause };
    if (matching) pendingFilter.userId = { $in: matching };
    const pending = scope.role ? [] : await this.memberships.listMembershipsAcrossTenants(ctx, kpmIds, pendingFilter);

    // 3. Accounts in no KPM — only when no KPM and no role narrows the list.
    let loose: {
      _id: unknown; fullName: string; email: string; phone?: string | null; companyId?: string | null; createdAt?: Date;
      testAccount?: boolean;
    }[] = [];
    if (!scope.kpmId && !scope.role) {
      const live = await this.memberships.liveMembershipCountsPerUserAcrossTenants(ctx);
      const allOffices = await this.kpms.find({ deletedAt: null }).select('_id').lean().exec() as { _id: unknown }[];
      const left = await this.memberships.listMembershipsAcrossTenants(ctx, allOffices.map((k) => String(k._id)), { status: 'removed' });
      const placedOrLeft = [...new Set([...live.keys(), ...left.map((m) => m.userId)])].filter((id) => isValidObjectId(id));
      const filter: Record<string, unknown> = {
        deletedAt: null, platformRole: { $ne: 'super_admin' }, _id: { $nin: placedOrLeft },
      };
      if (scope.companyId) filter.companyId = scope.companyId;
      if (q) filter.$or = searchOf(q, { phone: true });
      if (scope.testAccount === 'only') filter.testAccount = true;
      else if (scope.testAccount !== 'include') filter.testAccount = { $ne: true };
      loose = await this.users.find(filter).select('fullName email phone companyId createdAt testAccount').lean().exec() as typeof loose;
    }

    const invitedUsers = new Set(invited.flatMap((i) => (i.userId ? [i.userId] : [])));
    const people = await this.peopleOf([...pending.map((m) => m.userId), ...invited.flatMap((i) => (i.userId ? [i.userId] : []))]);
    const companyName = await this.companyNames([...companyIds, ...loose.flatMap((u) => (u.companyId ? [u.companyId] : []))]);
    const ladders = await this.orgLevels.laddersByCompany(companyIds);
    const day = (tz: string, at: Date | null | undefined) => this.clock.localDateFor(tz, at ?? now);
    const companyOf = (id: string | null | undefined) => (id && companyName.has(id) ? { id, name: companyName.get(id)! } : null);

    const rows: WaitingRow[] = [];
    for (const inv of invited) {
      const office = byOffice.get(inv.kpmId);
      if (!office) continue;
      const rung = ladders.get(office.companyId)?.find((l) => l.code === inv.orgLevelCode);
      rows.push({
        kind: 'invited',
        invitationId: String(inv._id),
        userId: inv.userId ?? null,
        membershipId: null,
        fullName: inv.userId ? people.get(inv.userId)?.fullName ?? inv.fullName : inv.fullName,
        avatarUrl: null,
        email: null,
        company: companyOf(office.companyId),
        kpm: { id: inv.kpmId, code: office.code, branch: office.branchName },
        role: { code: inv.orgLevelCode, label: rung?.label ?? inv.orgLevelCode, class: inv.roleClass },
        since: day(office.timezone, inv.invitedAt),
        expired: userInvitationStateOf(inv, now) === 'expired',
        testAccount: false,
        // The number the invitation was sent to: normalised when it was written.
        hasPhone: true,
      });
    }
    for (const m of pending) {
      if (invitedUsers.has(m.userId)) continue;
      const office = byOffice.get(m.kpmId);
      if (!office) continue;
      const person = people.get(m.userId);
      rows.push({
        kind: 'unplaced',
        invitationId: null,
        userId: m.userId,
        membershipId: String(m._id),
        fullName: person?.fullName ?? '',
        avatarUrl: null,
        email: person?.email ?? null,
        company: companyOf(office.companyId),
        kpm: { id: m.kpmId, code: office.code, branch: office.branchName },
        role: null,
        since: day(office.timezone, person?.createdAt ?? m.createdAt ?? null),
        expired: false,
        testAccount: person?.testAccount ?? false,
        hasPhone: normalisePhone(person?.phone) !== null,
      });
    }
    for (const u of loose) {
      const id = String(u._id);
      if (invitedUsers.has(id)) continue;
      rows.push({
        kind: 'unplaced',
        invitationId: null,
        userId: id,
        membershipId: null,
        fullName: u.fullName,
        avatarUrl: null,
        email: u.email,
        company: companyOf(u.companyId),
        kpm: null,
        role: null,
        // An account belongs to no office: its day in the one zone v1 has (ADR-0016), never the server's.
        since: day(DEFAULT_TENANT_TIMEZONE, u.createdAt ?? null),
        expired: false,
        testAccount: u.testAccount === true,
        hasPhone: normalisePhone(u.phone) !== null,
      });
    }
    return rows;
  }

  private async peopleOf(userIds: readonly string[]): Promise<Map<string, {
    fullName: string; email: string; phone: string | null; createdAt?: Date; testAccount: boolean;
  }>> {
    const ids = [...new Set(userIds)].filter((id) => isValidObjectId(id));
    if (ids.length === 0) return new Map();
    const rows = await this.users.find({ _id: { $in: ids } }).select('fullName email phone createdAt testAccount').lean().exec() as
      { _id: unknown; fullName: string; email: string; phone?: string | null; createdAt?: Date; testAccount?: boolean }[];
    return new Map(rows.map((u) => [String(u._id), {
      fullName: u.fullName, email: u.email, phone: u.phone ?? null, createdAt: u.createdAt, testAccount: u.testAccount === true,
    }]));
  }

  private async companyNames(ids: readonly string[]): Promise<Map<string, string>> {
    const valid = [...new Set(ids)].filter((id) => isValidObjectId(id));
    if (valid.length === 0) return new Map();
    const rows = await this.companies.find({ _id: { $in: valid } }).select('name').lean().exec() as { _id: unknown; name: string }[];
    return new Map(rows.map((c) => [String(c._id), c.name]));
  }
}

/** An invitation a search finds: by the name typed, the number (however it was typed) or the email — or its account's. */
function matchesInvitation(
  inv: { fullName: string; phone: string; email: string | null; userId: string | null },
  q: string,
  matching: string[] | null,
): boolean {
  if (inv.userId && matching?.includes(inv.userId)) return true;
  const lower = q.toLowerCase();
  if (inv.fullName.toLowerCase().includes(lower) || (inv.email ?? '').includes(lower)) return true;
  const digits = q.replace(/[\s\-().+]/g, '');
  if (/^\d{4,}$/.test(digits)) {
    const national = digits.replace(/^62/, '').replace(/^0/, '');
    return inv.phone.replace(/^\+62/, '').includes(national);
  }
  return false;
}
