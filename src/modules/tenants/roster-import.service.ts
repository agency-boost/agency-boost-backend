import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf } from '@/common/time/local-day';
import { can } from '@/modules/rbac/permissions';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { isLeaderClass } from '@/domain/constants';
import { countLeadersUsed, leaderLimitReached } from '@/modules/org/leader-limit';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { PasswordService } from '@/modules/auth/password.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Kpm, KpmDocument } from './kpm.schema';
import {
  generateTemporaryPassword,
  inLeaderFirstOrder,
  isRungCode,
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
  /**
   * The office's calendar day, which a birth date and a join month are measured against (ADR-0158 §2):
   * the injected clock, in the office's own timezone (invariant §9).
   */
  private todayIn(kpm: KpmDocument): string {
    return localDayOf(this.clock.now(), kpm.timezone);
  }

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
    // The company's own ladder (OD-50): a row may name any of its live rungs, a rung it added included.
    const rungs = await this.hierarchy.rungClassesOf(String(kpm._id));

    for (const row of rows) {
      // A code the parser found well-formed, which is no live rung of this company's ladder. A malformed one
      // already has the parser's issue.
      if (isRungCode(row.role) && !rungs.has(row.role.toUpperCase())) {
        issues.push({
          line: row.line,
          column: 'role',
          message: `"${row.role.toUpperCase()}" is not a rung of this company’s ladder. Use one of: `
            + `${[...rungs.keys()].sort().join(', ')}.`,
        });
      }
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

  /**
   * *Leaders used*, and the maximum, for the office being filled (ADR-0113, P13.2-T4). `max` is
   * `null` when the office has no limit, and then nothing here is ever refused.
   */
  private async seats(kpm: KpmDocument): Promise<{ max: number | null; used: number }> {
    const max = kpm.subscription?.maxLeaders ?? null;
    if (max === null) return { max, used: 0 };
    const used = await countLeadersUsed(
      this.members, RequestContext.tenantRead(String(kpm._id), 'roster-import'),
    );
    return { max, used };
  }

  /**
   * **Each row that would pass the office's leader limit, as an issue** (P13.2-T4 AC-4), with its line
   * and the *role* column, in the issue list the import already has — so the file is refused whole and
   * nothing commits. Rows are counted in the file's order: the first ABs and AABs that fit are fine,
   * and every one after them is named.
   *
   * The words differ by reader (AC-5): the Super Admin is told where to raise the limit, an Owner or an
   * Admin that AgencyBoost can. Neither is shown a code.
   */
  private async issuesAgainstTheLimit(
    ctx: RequestContext,
    kpm: KpmDocument,
    rows: RosterRow[],
  ): Promise<RosterIssue[]> {
    const { max, used } = await this.seats(kpm);
    if (max === null) return [];

    const issues: RosterIssue[] = [];
    const leads = await this.leadsOnTheLadder(kpm);
    let leaders = used;
    for (const row of [...rows].sort((a, b) => a.line - b.line)) {
      if (!leads(row.role)) continue;
      leaders += 1;
      if (leaders <= max) continue;
      const already = `${used} ${used === 1 ? 'is' : 'are'} in use already`;
      issues.push({
        line: row.line,
        column: 'role',
        /*
         * ADR-0157 §5: a row past the limit is still refused, never queued — its temporary password is shown
         * once, to the importer, and could not be handed over after an approval. So the office is told the way
         * through that asks: import them as an Agent, then promote them, which asks AgencyBoost.
         */
        message: ctx.isSuperAdmin
          ? `This office’s leader limit is ${max} — ABs and AABs together — and ${already}, so this `
            + `row would be one too many. Raise the limit with Edit subscription on the offices list `
            + 'first, or import them as an Agent.'
          : `Your office’s leader limit is ${max} — ABs and AABs together — and ${already}, so this `
            + 'row would be one too many. Import them as an Agent, then promote them on their page: past the '
            + 'limit, that asks AgencyBoost to approve it.',
      });
    }
    return issues;
  }

  async preview(ctx: RequestContext, kpmId: string, text: string): Promise<RosterPreview> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);

    const { rows, issues } = parseRoster(text, this.todayIn(kpm));
    const all = [
      ...issues,
      ...(await this.issuesAgainstTheOffice(kpm, rows)),
      ...(await this.issuesAgainstTheLimit(ctx, kpm, rows)),
    ]
      .sort((a, b) => a.line - b.line || a.column.localeCompare(b.column));

    return {
      issues: all,
      willCreate: all.length === 0 ? rows.length : 0,
      rows: rows.map(({ line, fullName, email, agentCode, role }) => ({
        line, fullName, email, agentCode, role,
      })),
    };
  }

  async commit(ctx: RequestContext, kpmId: string, text: string): Promise<RosterCommitResult> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);

    const { rows, issues } = parseRoster(text, this.todayIn(kpm));
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

    /*
     * **The leader limit, again** (P13.2-T4 AC-4). The preview named every row past it; this is the
     * office that filled up between the preview and the commit — a promotion in another tab — and it
     * refuses whole with the limit's own code, before anybody is created. Each row's write is checked
     * once more inside `HierarchyService.create`, which is what holds when a promotion lands while
     * this very loop runs.
     */
    const { max, used } = await this.seats(kpm);
    const leads = max === null ? () => false : await this.leadsOnTheLadder(kpm);
    const leadersInFile = rows.filter((row) => leads(row.role)).length;
    if (max !== null && leadersInFile > 0 && used + leadersInFile > max) {
      throw leaderLimitReached(max, used);
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
      // Hashed before the write, so the leader lease is never held while a hash is computed.
      const passwordHash = await this.passwords.hash(temporaryPassword);
      const makeAccount = async () => {
        const account = await this.users.create({
          email: row.email,
          passwordHash,
          fullName: row.fullName,
          companyId: kpm.companyId,
          agentCode: row.agentCode,
          // What the person records (ADR-0158): checked by the parser, so none is missing here.
          dateOfBirth: row.dateOfBirth,
          companyJoinMonth: row.companyJoinMonth,
          gender: row.gender,
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
        return String(account._id);
      };

      const leaderId = row.leaderAgentCode
        ? madeInThisRun.get(row.leaderAgentCode) ?? (await this.existingLeader(kpm, row))
        : null;

      /*
       * **The account is made inside the membership's write** (P13.2 exit review). It used to be made
       * first, and a leader row the limit refused — the office filled while this loop ran — left the
       * account behind: a person in no office, whose email then refused the same row on the next
       * import. `createWithAccount` makes it only once the row has its seat, with the lease held.
       */
      const membership = await this.hierarchy.createWithAccount(scoped, {
        // The rung's code, a lookup key — any live rung of the company's ladder (OD-50).
        role: row.role,
        leaderId,
        status: 'active',
        // How they work in this office is the membership's (ADR-0158 §1), not the account's.
        workStatus: row.workStatus,
      }, makeAccount);
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

  /**
   * **Whether a row's rung makes a leader**, by the rung's tier on the office's company ladder (ADR-0156): the
   * file names the rung by code, and the class it gives — not the code — is what the leader limit counts. A code
   * that is no active rung leads nobody here, and its own write is refused `ORG_LEVEL_NOT_ON_LADDER`.
   */
  private async leadsOnTheLadder(kpm: KpmDocument): Promise<(rung: string) => boolean> {
    const classes = await this.hierarchy.rungClassesOf(String(kpm._id));
    return (rung) => isLeaderClass(classes.get(rung.toUpperCase()));
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
