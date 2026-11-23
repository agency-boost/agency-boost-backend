import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf } from '@/common/time/local-day';
import { shortOfRung } from '@/domain/constants';
import { isTestAccount } from '@/domain/constants/test-accounts';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthToken, type AuthTokenDocument } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { renderPdf } from '@/modules/proposals/proposal-pdf.builder';
import { dispositionOf } from '@/modules/proposals/proposal-pdf.layout';
import { can } from '@/modules/rbac/permissions';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { NOT_A_TEST_ACCOUNT } from './counted-members';
import { ownsAccount } from './invitation-state';
import { MembershipRepository } from './membership.repository';
import type { MembershipDocument } from './membership.schema';
import { sheetFileName, temporaryPasswordsDocument, type SheetRow } from './temporary-passwords.layout';
import { TEMPORARY_PASSWORDS_REFUSALS } from './temporary-passwords.messages';

/** The permission both routes require (roles §3.3; OD-479). */
export const ISSUE_TEMPORARY_PASSWORDS = 'member:issue_temporary_password' as const;

/** The audit action an issue writes (labelled in `audit-labels.messages.ts`). */
export const TEMPORARY_PASSWORDS_ISSUED = 'member.temporary_passwords_issued' as const;

/** What `revokedReason` says on the sessions an issue ends. */
const REVOKED_REASON = 'temporary password issued';

/** Hashes made at once: Argon2id takes 19 MiB each, so a KPM of a hundred is hashed two at a time. */
const HASH_CONCURRENCY = 2;

/** The file the route answers: its bytes, its `Content-Disposition`, its pages, and how many people it lists. */
export interface TemporaryPasswordsFile { bytes: Buffer; disposition: string; pages: number; count: number }

/** One person the PDF lists, before a password is issued. */
interface Listed {
  membership: MembershipDocument;
  account: UserDocument;
  role: string;
}

/**
 * **An account not yet its person's own** (ADR-0288 §1): still on a temporary password, or never signed in with no address
 * proven (OD-475's `ownsAccount` false). An account the person owns is never listed, and its password never touched.
 */
export function awaitsItsPerson(account: Pick<UserDocument, 'mustChangePassword' | 'lastLoginAt' | 'emailVerifiedAt'>): boolean {
  return account.mustChangePassword === true || !ownsAccount(account);
}

/**
 * **The same test, as a filter** — what an issue's write is conditioned on, so an account whose person chose their own
 * password between the read and the write is left alone (and left off the PDF).
 */
const awaitsItsPersonFilter = () => ({
  $or: [{ mustChangePassword: true }, { lastLoginAt: null, emailVerifiedAt: null }],
});

/**
 * ***Unduh akun & password (PDF)*** (P19.30-T1;
 * [ADR-0288](../../../../docs/04-adr/0288-a-kpm-may-hand-out-temporary-passwords-in-one-pdf-and-each-person-chooses-their-own-at-first-sign-in.md)).
 *
 * - **Who is listed** (§1): each **active** member of the KPM in context whose account is not yet theirs
 *   (`awaitsItsPerson`) — never an account its person owns, a test account (`users.testAccount` or the membership's copy)
 *   a Super Admin, a deactivated account, or the reader's own. `membershipIds` narrows it to those memberships, every one
 *   of which must be this KPM's (another's is `404`, as a member of another KPM is everywhere).
 * - **What an issue does** (§1, §2; OD-478): a fresh `TEMPORARY_PASSWORD` for each, of which **only the hash is written**
 *   (`PasswordService`, the auth module's Argon2id), with `mustChangePassword: true` — so the person reaches nothing but
 *   `/choose-a-password` until they choose their own (`AuthGuard`) — and their sessions ended, so an older PDF's password
 *   and whatever it signed in are both gone. Each write is conditioned on the account still awaiting its person.
 * - **The PDF** (§2): built in memory from the rows actually written (`temporary-passwords.layout.ts`, the proposal's
 *   renderer), never kept. It is the only place a password exists in readable form.
 * - **Audited** `member.temporary_passwords_issued` in the KPM's log, **or the request fails** (`recordInScopesOrFail`):
 *   the count and the memberships, never a password.
 * - **One issue at a time per KPM**: two downloads at once would each print passwords the other had overwritten.
 * - **Who may** (§3; OD-479): `member:issue_temporary_password` — the KPM's Owners, and the Super Admin inside the KPM;
 *   never a KPM Admin, never in a support session. The route's guard first, and this again.
 */
@Injectable()
export class TemporaryPasswordsService {
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly members: MembershipRepository,
    // `users` and `authTokens` are global (a credential is a person's, not an office's); `kpms` and `companies` are read
    // by id for the sheet's first line.
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    private readonly passwords: PasswordService,
    private readonly orgLevels: OrgLevelService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /** The app's own address, for *Masuk di …* (OD-482). `@Optional` for the specs that build this by hand. */
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * **`POST /members/temporary-passwords/preview`** — how many the PDF would list, the KPM's name and what the file will
   * be saved as. Issues nothing.
   */
  async preview(ctx: RequestContext, membershipIds?: string[]): Promise<{ count: number; kpmName: string; fileName: string }> {
    const { kpm, listed } = await this.listed(ctx, membershipIds);
    const day = localDayOf(this.clock.now(), kpm.timezone);
    return { count: listed.length, kpmName: kpm.branchName, fileName: sheetFileName(kpm.branchName, day).name };
  }

  /** **`POST /members/temporary-passwords`** — issue, and answer the PDF. */
  async issue(ctx: RequestContext, membershipIds?: string[]): Promise<TemporaryPasswordsFile> {
    this.require(ctx);
    const kpmId = ctx.kpmId as string;
    const before = this.running.get(kpmId) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => this.issueNow(ctx, membershipIds));
    this.running.set(kpmId, mine);
    try {
      return await mine;
    } finally {
      if (this.running.get(kpmId) === mine) this.running.delete(kpmId);
    }
  }

  // ---------------------------------------------------------------------------------------------- parts

  private require(ctx: RequestContext): void {
    if (ctx.isImpersonating || !ctx.kpmId || !can(ctx, ISSUE_TEMPORARY_PASSWORDS)) {
      throw new PermissionDeniedException(ISSUE_TEMPORARY_PASSWORDS);
    }
  }

  private async issueNow(ctx: RequestContext, membershipIds?: string[]): Promise<TemporaryPasswordsFile> {
    const { kpm, listed } = await this.listed(ctx, membershipIds);
    if (listed.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, TEMPORARY_PASSWORDS_REFUSALS.VALIDATION_FAILED.nobodyToList, HttpStatus.BAD_REQUEST,
        { listed: 0 },
      );
    }

    // Each password made, then hashed — the hash is all that is written; the password lives in this request alone.
    const issued = listed.map((person) => ({ person, password: this.passwords.generateTemporary(), hash: '' }));
    for (let i = 0; i < issued.length; i += HASH_CONCURRENCY) {
      await Promise.all(issued.slice(i, i + HASH_CONCURRENCY).map(async (one) => {
        one.hash = await this.passwords.hash(one.password);
      }));
    }

    const now = this.clock.now();
    const written: typeof issued = [];
    for (const one of issued) {
      const { modifiedCount } = await this.users.updateOne(
        { _id: one.person.account._id, deletedAt: null, ...awaitsItsPersonFilter() },
        { $set: { passwordHash: one.hash, mustChangePassword: true } },
      ).exec();
      if (modifiedCount === 0) continue;
      // An older PDF's password, and whatever it signed in, end here (OD-478).
      await this.tokens.updateMany(
        { userId: String(one.person.account._id), kind: 'refresh', revokedAt: null },
        { $set: { revokedAt: now, revokedReason: REVOKED_REASON } },
      ).exec();
      written.push(one);
    }
    if (written.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, TEMPORARY_PASSWORDS_REFUSALS.VALIDATION_FAILED.nobodyToList, HttpStatus.BAD_REQUEST,
        { listed: 0 },
      );
    }

    const membershipIdsIssued = written.map((one) => String(one.person.membership._id));
    await this.audit.recordInScopesOrFail(ctx, [{
      kpmId: String(kpm._id),
      entry: {
        action: TEMPORARY_PASSWORDS_ISSUED,
        targetCollection: 'memberships',
        targetId: String(kpm._id),
        // Who, the count and the memberships — **never a password** (ADR-0288 §3).
        after: { count: written.length, membershipIds: membershipIdsIssued, narrowed: membershipIds !== undefined },
      },
    }]);

    const day = localDayOf(now, kpm.timezone);
    const company = await this.companies.findById(kpm.companyId, { name: 1 }).lean().exec().catch(() => null);
    const rows: SheetRow[] = written.map(({ person, password }) => ({
      fullName: person.account.fullName,
      role: person.role,
      agentCode: person.membership.agentCode ?? person.account.agentCode ?? '',
      email: person.account.email,
      password,
    }));
    const built = await renderPdf(temporaryPasswordsDocument({
      kpm: { name: kpm.branchName, company: company?.name ?? '' },
      day,
      signInAt: this.signInAddress(),
      rows,
    }, now));
    return { bytes: built.bytes, disposition: dispositionOf(sheetFileName(kpm.branchName, day)), pages: built.pages, count: rows.length };
  }

  /** *Masuk di agencyboost.id/login*: the app's address without its scheme, as a person types it. */
  private signInAddress(): string {
    const origin = (this.config?.get<string>('APP_ORIGIN') ?? 'http://localhost:3000').replace(/\/+$/, '');
    try {
      const url = new URL(origin);
      return `${url.host}${url.pathname.replace(/\/+$/, '')}/login`;
    } catch {
      return `${origin}/login`;
    }
  }

  /**
   * **Who the PDF lists** (§1): the KPM in context, its active members not test accounts, each one's account not yet
   * theirs — by name, A to Z, in the KPM's own collation.
   */
  private async listed(ctx: RequestContext, membershipIds?: string[]): Promise<{ kpm: KpmDocument; listed: Listed[] }> {
    this.require(ctx);
    const kpm = await this.kpms.findOne({ _id: ctx.kpmId, deletedAt: null }).exec().catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');

    const named = membershipIds ? [...new Set(membershipIds)] : null;
    if (named) {
      // Every one named must be this KPM's: another KPM's membership is `404`, never a silent skip that would confirm it.
      const found = await this.members.count(ctx, { _id: { $in: named } });
      if (found !== named.length) throw new NotFoundException('Membership');
    }
    const rows = await this.members.find(
      ctx,
      { status: 'active', ...NOT_A_TEST_ACCOUNT, ...(named ? { _id: { $in: named } } : {}) },
      { projection: { userId: 1, agentCode: 1, orgLevelCode: 1, role: 1 } },
    );
    if (rows.length === 0) return { kpm, listed: [] };

    const [accounts, ladders] = await Promise.all([
      this.users.find(
        { _id: { $in: [...new Set(rows.map((r) => r.userId))] }, deletedAt: null },
        {
          fullName: 1, email: 1, agentCode: 1, mustChangePassword: 1, lastLoginAt: 1, emailVerifiedAt: 1, platformRole: 1,
          testAccount: 1, status: 1,
        },
      ).exec(),
      this.orgLevels.laddersByCompany([kpm.companyId]),
    ]);
    const byId = new Map(accounts.map((a) => [String(a._id), a]));
    const rungs = new Map((ladders.get(kpm.companyId) ?? []).map((rung) => [rung.code, shortOfRung(rung)]));

    const seen = new Set<string>();
    const listed: Listed[] = [];
    for (const membership of rows) {
      const account = byId.get(membership.userId);
      if (!account || seen.has(membership.userId)) continue;
      if (account.platformRole === 'super_admin' || isTestAccount(account) || account.status === 'deactivated') continue;
      if (membership.userId === ctx.userId || !account.email || !awaitsItsPerson(account)) continue;
      seen.add(membership.userId);
      listed.push({ membership, account, role: rungs.get(membership.orgLevelCode) ?? membership.orgLevelCode });
    }
    listed.sort((a, b) => a.account.fullName.localeCompare(b.account.fullName, 'id', { sensitivity: 'base' }));
    return { kpm, listed };
  }
}
