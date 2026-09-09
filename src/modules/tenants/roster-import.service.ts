import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can } from '@/modules/rbac/permissions';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Kpm, KpmDocument } from './kpm.schema';
import {
  generateTemporaryPassword,
  inLeaderFirstOrder,
  parseRoster,
  type RosterIssue,
  type RosterRow,
} from './roster-csv';

export interface RosterPreview {
  /** Everything wrong, per row, in one pass. Empty means the file will commit. */
  issues: RosterIssue[];
  /** How many people the commit would create. Zero when anything is wrong. */
  willCreate: number;
  rows: Array<{ line: number; fullName: string; email: string; agentCode: string; role: string }>;
}

export interface RosterCommitResult {
  created: Array<{ fullName: string; email: string; agentCode: string; temporaryPassword: string }>;
}

/**
 * Filling an office from a spreadsheet (P3.6-T4).
 *
 * **Template, upload, preview with a per-row issue list, commit** — the shape P9-T2/T3
 * specifies for the production import, reused deliberately so the two do not invent two
 * vocabularies for the same job.
 *
 * **Nothing is written until commit, and commit writes nothing if anything is wrong.**
 * A partial roster is worse than none: the admin cannot tell which half landed, and
 * re-uploading the file would refuse every row that did. There are no transactions here
 * (ADR-0002), so the guarantee is bought by validating the whole file first — which the
 * preview already does, and commit does again rather than trusting a preview the caller
 * might not have run.
 *
 * **Each account gets a generated password, returned once.** The admin passes it on by
 * email; `mustChangePassword` is set, so `AuthGuard` refuses every route but the ones
 * that replace it. The password is never stored in plaintext and appears in no audit row
 * — the commit response is the only place it exists outside the recipient's inbox.
 */
@Injectable()
export class RosterImportService {
  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private require(ctx: RequestContext): void {
    if (!can(ctx, 'kpm:import_roster')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to import a roster.',
        HttpStatus.FORBIDDEN,
        { permission: 'kpm:import_roster' },
      );
    }
  }

  /**
   * The office, and the check that the caller may reach *this* one.
   *
   * A Super Admin holds the permission at `all` and provisions offices they are not in.
   * An Owner or an Admin holds it at `own-kpm` — so naming somebody else's office has to
   * be refused, and refused as **404**, the same answer as an office that does not exist.
   * A 403 would confirm the id is real, which is the rule everywhere else in this product.
   */
  private async office(ctx: RequestContext, kpmId: string): Promise<KpmDocument> {
    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500 — it arrives from a URL.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');
    if (!ctx.isSuperAdmin && ctx.kpmId !== String(kpm._id)) throw new NotFoundException('KPM');
    return kpm;
  }

  /**
   * The context the writes run under.
   *
   * An Owner or Admin importing into their own office writes as themselves, so the
   * history and audit rows name the person who did it. Only a Super Admin — who is a
   * member of nothing — needs the office named for them.
   *
   * Reaching for `superAdminInTenant` unconditionally would have quietly promoted every
   * importing Owner to `platformRole: 'super_admin'` for the duration of the write, and
   * every membership they created would have been attributed to a platform operator.
   */
  private writeContext(ctx: RequestContext, kpmId: string): RequestContext {
    return ctx.kpmId === kpmId ? ctx : RequestContext.superAdminInTenant(ctx.userId, kpmId);
  }

  /**
   * Everything the file cannot decide about itself.
   *
   * The parser knows shape, blanks and duplicates *within* the file. What it cannot know
   * is what the company and the office already contain, which is all of this.
   */
  private async issuesAgainstTheOffice(
    kpm: KpmDocument,
    rows: RosterRow[],
  ): Promise<RosterIssue[]> {
    const issues: RosterIssue[] = [];
    const inFile = new Set(rows.map((r) => r.agentCode));

    for (const row of rows) {
      if (row.email) {
        const existing = await this.users.findOne({ email: row.email, deletedAt: null }).exec();
        if (existing) {
          issues.push({
            line: row.line,
            column: 'email',
            message: 'Already has an account. Import creates people; this one exists already.',
          });
        }
      }

      if (row.agentCode) {
        // Unique per company (ADR-0017), so the clash is with the insurer's whole book —
        // not only with this office.
        const held = await this.users
          .findOne({ companyId: kpm.companyId, agentCode: row.agentCode, deletedAt: null })
          .exec();
        if (held) {
          issues.push({
            line: row.line,
            column: 'agentCode',
            message: `Already registered at this insurer by ${held.email}.`,
          });
        }
      }

      if (row.leaderAgentCode && !inFile.has(row.leaderAgentCode)) {
        // Not in the file, so it has to be somebody already in this office. A leader who
        // is neither is a row-level issue, never a silent orphan.
        const leader = await this.members.find(
          RequestContext.tenantRead(String(kpm._id), 'roster-import'),
          { agentCode: row.leaderAgentCode, status: 'active' },
        );
        if (leader.length === 0) {
          issues.push({
            line: row.line,
            column: 'leaderAgentCode',
            message: `No active member of this office has the code ${row.leaderAgentCode}, and `
              + 'it is not in this file either.',
          });
        }
      }
    }

    if (rows.length > 0 && inLeaderFirstOrder(rows) === null) {
      issues.push({
        line: 1,
        column: 'leaderAgentCode',
        message: 'The leader columns form a loop, so nobody in it could be created first.',
      });
    }

    return issues;
  }

  async preview(ctx: RequestContext, kpmId: string, csv: string): Promise<RosterPreview> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);

    const { rows, issues } = parseRoster(csv);
    const all = [...issues, ...(await this.issuesAgainstTheOffice(kpm, rows))]
      .sort((a, b) => a.line - b.line || a.column.localeCompare(b.column));

    return {
      issues: all,
      willCreate: all.length === 0 ? rows.length : 0,
      rows: rows.map(({ line, fullName, email, agentCode, role }) => ({
        line, fullName, email, agentCode, role,
      })),
    };
  }

  async commit(ctx: RequestContext, kpmId: string, csv: string): Promise<RosterCommitResult> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);

    const { rows, issues } = parseRoster(csv);
    const all = [...issues, ...(await this.issuesAgainstTheOffice(kpm, rows))];
    if (all.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        `${all.length} row${all.length === 1 ? '' : 's'} would not import. Nothing was created — `
          + 'fix the file and upload it again.',
        HttpStatus.BAD_REQUEST,
        { issues: all },
      );
    }
    if (rows.length === 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'That file has a header and no people in it.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Checked above, so this cannot be null — but the ordering is what makes the loop
    // below work at all, and reading it from the same function keeps the two in step.
    const ordered = inLeaderFirstOrder(rows) as RosterRow[];
    const scoped = this.writeContext(ctx, String(kpm._id));
    const created: RosterCommitResult['created'] = [];
    // Codes created in this run, so a leader named by somebody later in the file resolves.
    const madeInThisRun = new Map<string, string>();

    for (const row of ordered) {
      const temporaryPassword = generateTemporaryPassword();
      const account = await this.users.create({
        email: row.email,
        passwordHash: await this.passwords.hash(temporaryPassword),
        fullName: row.fullName,
        companyId: kpm.companyId,
        agentCode: row.agentCode,
        // **The credential the admin has read opens nothing but the screen that replaces
        // it.** Set here rather than by a later sweep: an account that reached `active`
        // without it would be a permanent hole.
        mustChangePassword: true,
        // Pre-verified: the admin vouched for the address by putting it in the file, and
        // the password is going to that address anyway — an unverified account could not
        // sign in to receive it.
        emailVerifiedAt: this.clock.now(),
        status: 'active',
        platformRole: 'none',
      });

      const leaderId = row.leaderAgentCode
        ? madeInThisRun.get(row.leaderAgentCode) ?? (await this.existingLeader(kpm, row))
        : null;

      const membership = await this.hierarchy.create(scoped, {
        userId: String(account._id),
        role: row.role as 'ab' | 'aab' | 'agent',
        leaderId,
        status: 'active',
      });
      madeInThisRun.set(row.agentCode, String(membership._id));

      created.push({
        fullName: row.fullName,
        email: row.email,
        agentCode: row.agentCode,
        temporaryPassword,
      });
    }

    await this.audit.record(scoped, {
      action: 'roster.imported',
      targetCollection: 'memberships',
      targetId: String(kpm._id),
      // Names and codes, never a password. The generated ones exist in the response and
      // in the recipients' inboxes, and nowhere else.
      after: { count: created.length, agentCodes: created.map((c) => c.agentCode) },
    });

    return { created };
  }

  private async existingLeader(kpm: KpmDocument, row: RosterRow): Promise<string> {
    const found = await this.members.find(
      RequestContext.tenantRead(String(kpm._id), 'roster-import'),
      { agentCode: row.leaderAgentCode, status: 'active' },
    );
    // Validated in `issuesAgainstTheOffice`, so this is a backstop rather than a branch
    // anybody reaches — but a silent `null` here would orphan somebody.
    if (found.length === 0) throw new NotFoundException('Membership');
    return String(found[0]._id);
  }
}
