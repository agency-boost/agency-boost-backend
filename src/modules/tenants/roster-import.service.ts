import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { render, type Message } from '@/common/i18n/sentence';
import type { FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { localDayOf } from '@/common/time/local-day';
import {
  isLeaderClass, roleClassOf, ROSTER_INVITATION, shortOfRung, tierOfRung, type RoleClass,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { agentCodePattern } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { AuthToken, type AuthTokenDocument } from '@/modules/auth/auth-token.schema';
import { PasswordService } from '@/modules/auth/password.service';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { InvitesService } from '@/modules/org/invites.service';
import { countLeadersUsed } from '@/modules/org/leader-limit';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import type { MembershipHistoryDocument } from '@/modules/org/membership-history.schema';
import { ONBOARDING_REFUSALS } from '@/modules/org/onboarding.messages';
import { MemberInviteRepository, MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { can } from '@/modules/rbac/permissions';
import { User, UserDocument } from '@/modules/users/user.schema';
import { Kpm, KpmDocument } from './kpm.schema';
import { OrgLevelService, type OrgLevelRow } from './org-level.service';
import {
  parseRoster, ROSTER_COLUMNS, ROSTER_HEADER_NAMES, skippedRowsCsv, type AgentCodeRule, type ParsedRoster, type RosterField,
  type RosterRow,
} from './roster-csv';
import { rosterTextOf, rosterWorkbook } from './roster-file';
import { ROSTER_ROW_WORDS } from './roster-import.messages';
import { TENANTS_REFUSALS } from './tenants.messages';

/** The import's refusals and each cell's problem, in both languages (P18.10-T5 AC-3). */
const SAY = TENANTS_REFUSALS.VALIDATION_FAILED;
/** What each row comes to (P19.3-T4; A3). */
const ROW = ROSTER_ROW_WORDS;

/** One problem with the file as a whole, as the preview answers it: its words written for the reader. */
export interface RosterIssueView {
  line: number;
  column: string;
  message: string;
}

/**
 * **Skipped, updated or imported** (A3): what a row comes to — or, since ADR-0250 §4, **invited**: a new Agent with no
 * email, invited on WhatsApp as *+ Tambah agent* invites (ADR-0170), who registers through the link.
 */
export type RosterOutcome = 'imported' | 'updated' | 'invited' | 'skipped';

/** One row of the file and what it comes to, in the file's order. */
export interface RosterRowView {
  line: number;
  agentCode: string;
  fullName: string;
  /** The rung as the file names it. */
  role: string;
  leaderAgentCode: string;
  email: string;
  outcome: RosterOutcome;
  /** A3's words for the row, written for the reader: why it is skipped, or what importing or updating it notes. */
  messages: string[];
  /**
   * **What the row leaves out, written for the reader** (P19.12-T7 AC-2, AC-3; ADR-0250 §2, §3): each optional cell
   * left empty for its shape, no WhatsApp number, and the person's details neither the row nor the record holds. Empty
   * for a skipped row, whose bad cells are among its `messages`.
   */
  warnings: string[];
  /**
   * **The invitation the commit made, to share on WhatsApp** (ADR-0250 §4): its link — to registration — and the number
   * it goes to. Only in the commit's answer, only for an `invited` row: the link is made once and kept only as a hash.
   */
  invite?: { link: string; phone: string };
}

export interface RosterPreview {
  /** What makes the file unreadable as a whole. With any, `rows` is empty and nothing would be written. */
  issues: RosterIssueView[];
  /** The file's header, as it reads — what the skipped rows are written back under. */
  header: string[];
  /** *"N orang baru siap diimpor, M diperbarui, K baris dilewati"* (A3), and *J diundang lewat WhatsApp* (ADR-0250 §4). */
  counts: { imported: number; updated: number; invited: number; skipped: number };
  rows: RosterRowView[];
  /**
   * **The skipped rows, as a CSV** (A3's *"⬇ Unduh baris yang dilewati"*; ADR-0205 §8): the file's columns and an
   * `Alasan` column, the rows in the file's order, the reasons in the reader's language. `null` when nothing is skipped.
   */
  skippedCsv: string | null;
}

/**
 * What the commit did: the same rows, now done, and how many new people were **mailed** an invitation — not those invited
 * on WhatsApp, who are `counts.invited`.
 */
export interface RosterCommitResult extends RosterPreview {
  invited: number;
}

/** A row and what it comes to, before any of it is written. */
interface Plan {
  row: RosterRow;
  outcome: RosterOutcome;
  /** For a skipped row, why (the first reason found, A3's order); otherwise what importing or updating it notes. */
  reasons: Message[];
  /** What it leaves out (ADR-0250 §2, §3): the cells left empty, and the details missing. */
  warnings: Message[];
  rung: OrgLevelRow | null;
  /** The member an update row updates. */
  existing: MembershipDocument | null;
  /** Their account, for an update. */
  account: UserDocument | null;
}

/** What the office holds that a file is checked against, read once per check. */
interface Office {
  kpm: KpmDocument;
  ladder: OrgLevelRow[];
  /** A rung by what a file may call it: its code, its label or its short name, any case. */
  rungOf: (typed: string) => OrgLevelRow | null;
  /** Live members (active or pending), by id. */
  byId: Map<string, MembershipDocument>;
  /** Active members, by agent code. */
  activeByCode: Map<string, MembershipDocument>;
  /** Accounts at the insurer holding a code of the file, by code. */
  heldByCode: Map<string, UserDocument>;
  /** Addresses of the file that already have an account. */
  emailTaken: Set<string>;
  /** The accounts of the members an update row names, by user id. */
  accounts: Map<string, UserDocument>;
}

/** What the file's upline column resolves to: a row of the file still in, an active member, a skipped row, nothing. */
type Node = { code: string; rung: OrgLevelRow; leader: string } | 'skipped' | null;

/** Written on every edge an import opens, so the Role change log says where the change came from. */
const IMPORT_REASON = 'Member import';

/**
 * **A person's details an import may leave empty** (ADR-0250 §3), in the template's order: the join date and work status
 * the membership holds, the birth date, gender and join month the account holds.
 */
const DETAILS = ['joinDate', 'workStatus', 'dateOfBirth', 'gender', 'companyJoinMonth'] as const satisfies readonly RosterField[];
type Detail = (typeof DETAILS)[number];
/** The header names of some fields, joined for a sentence. */
const headers = (fields: readonly RosterField[]) => fields.map((field) => ROSTER_HEADER_NAMES[field]).join(', ');

/**
 * **An update never applies its email** (ADR-0181; ADR-0205 §5), so an address in the wrong shape on an update row is a
 * warning, not a reason to skip it (ADR-0250 §2): the row's *Email* problems become warnings and its email is blank.
 */
function forgivingEmail(row: RosterRow): RosterRow {
  const column = ROSTER_HEADER_NAMES.email;
  const bad = row.problems.filter((problem) => problem.column === column);
  if (bad.length === 0) return row;
  const order = (c: string) => ROSTER_COLUMNS.indexOf(c);
  return {
    ...row,
    email: '',
    problems: row.problems.filter((problem) => problem.column !== column),
    warnings: [...row.warnings, ...bad].sort((a, b) => order(a.column) - order(b.column)),
  };
}

/**
 * **The member import** (P3.2-T4; rewritten for the setup spec's §A3 by P19.3-T4, ADR-0205 §5 to §11): the Owner and
 * the Admin fill and update their own office from a spreadsheet. The Super Admin's grant went with P19.4-T2 (ADR-0206
 * §2; UI-151): the people are the office's, and the routes answer a Super Admin `403 PERM_DENIED`.
 *
 * **Template, upload, preview, commit**, as the production import. What changed under A3:
 *
 * - **Each row comes to one of three things**: *skipped*, with its reason; *updated* — a code already in this office,
 *   blank cells keeping what is stored; or *imported*, a new person. One bad row no longer stops a file.
 * - **Uplines are checked over the whole file and the office**, so row order does not matter; a loop is skipped, and so
 *   is a row whose upline's row is skipped.
 * - **The valid rows are committed as one unit.** There is no transaction (ADR-0152: one server, no replica set), so the
 *   commit checks the whole file again, writes leader first, and **on any failed write undoes what it wrote** — soft
 *   deletes the memberships, edges and accounts it made, and puts back what it changed — before it answers the failure.
 * - **Nobody reads a password.** A new account's password is a secret nobody holds; *Kirim undangan* mails each new
 *   person a one-time link to choose their own (the reset link's mechanism, P4-T14), and without it they use *Lupa kata
 *   sandi?*, which proves the mailbox the same way.
 */
@Injectable()
export class RosterImportService {
  private readonly logger = new Logger(RosterImportService.name);

  constructor(
    private readonly members: MembershipRepository,
    private readonly hierarchy: HierarchyService,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly orgLevels: OrgLevelService,
    private readonly history: MembershipHistoryRepository,
    private readonly notifications: NotificationService,
    /*
     * The invitation's one-time link (ADR-0205 §10): a `password_reset` token, which `/reset-password/<token>` consumes —
     * the reset link's mechanism. `authTokens` is platform-global (a credential belongs to a user, not an office).
     */
    @InjectModel(AuthToken.name) private readonly tokens: Model<AuthTokenDocument>,
    /**
     * The KPM's template's agent-code format, read live (P19.5-T1 AC-11; ADR-0214 §7). `@Optional` for the specs that
     * build this by hand; without it the global `AGENT_CODE_PATTERN` stands.
     */
    @Optional() private readonly analytics?: AnalyticsConfigReader,
    /**
     * **The invitation *+ Tambah agent* makes** (ADR-0250 §4; ADR-0170): a new Agent with no email is invited through it,
     * on WhatsApp. `@Optional` for the specs that build this by hand; without it such a row is skipped, as before.
     */
    @Optional() private readonly invitations?: InvitesService,
    /** Whether an agent code already has an invitation waiting (`ORG_INVITE_PENDING`), asked in the preview too. */
    @Optional() private readonly inviteRows?: MemberInviteRepository,
    /** The app's origin, for the invitation's link — as `/new-hires/agents` reads it. */
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** The format the KPM's template publishes for its agent codes, or none (the global pattern). */
  private async codeRuleOf(kpm: KpmDocument): Promise<AgentCodeRule | undefined> {
    if (!this.analytics) return undefined;
    const { config } = await this.analytics.forOffice(String(kpm._id));
    const compiled = agentCodePattern(config.uploadRules.agentCodePattern);
    return 'pattern' in compiled ? { test: compiled.pattern.test, example: config.uploadRules.agentCodeExample } : undefined;
  }

  private require(ctx: RequestContext): void {
    if (!can(ctx, 'kpm:import_roster')) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        TENANTS_REFUSALS.PERM_DENIED.importRoster,
        HttpStatus.FORBIDDEN,
        { permission: 'kpm:import_roster' },
      );
    }
  }

  /**
   * The office, and the check that the caller may reach *this* one: an Owner or an Admin their own — another office's
   * id is **404**, the same answer as an office that does not exist. A 403 would confirm the id is real.
   */
  private async office(ctx: RequestContext, kpmId: string): Promise<KpmDocument> {
    const kpm = await this.kpms
      .findOne({ _id: kpmId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500 — it arrives from a URL.
      .catch(() => null);
    if (!kpm) throw new NotFoundException('KPM');
    if (ctx.kpmId !== String(kpm._id)) throw new NotFoundException('KPM');
    return kpm;
  }

  /** The office's calendar day (ADR-0158 §2): the injected clock, in the office's own timezone (invariant §9). */
  private todayIn(kpm: KpmDocument): string {
    return localDayOf(this.clock.now(), kpm.timezone);
  }

  // ------------------------------------------------------------------ the template

  /**
   * **The member template as an Excel workbook** (ADR-0184), for the office named — or, for an Owner or an Admin who
   * names none, their own. The office decides one thing in it: *Peran* is a dropdown of its company ladder's rungs,
   * junior first. Another office's id is 404. (A Super Admin naming none had the column as free text until P19.4-T2.)
   */
  async workbook(ctx: RequestContext, kpmId: string | null): Promise<Buffer> {
    this.require(ctx);
    const office = await this.office(ctx, kpmId ?? String(ctx.kpmId));
    return rosterWorkbook(ctx.reader, (await this.ladderOf(office.companyId)).map(shortOfRung));
  }

  // ------------------------------------------------------------------ preview and commit

  /** The rows as text, pasted (`RosterRowsDto`): what a check reads. Writes nothing. */
  async preview(ctx: RequestContext, kpmId: string, text: string): Promise<RosterPreview> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);
    return this.previewOf(ctx, kpm, text);
  }

  /** **The rows as a file — an Excel workbook or a CSV** (ADR-0184), read to the same text a paste is. */
  async previewFile(ctx: RequestContext, kpmId: string, file: FileUpload | undefined): Promise<RosterPreview> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);
    return this.previewOf(ctx, kpm, await this.textOf(file));
  }

  /** The valid rows, as one unit; `invite` mails each new person their link (ADR-0205 §10). */
  async commit(ctx: RequestContext, kpmId: string, text: string, invite = true): Promise<RosterCommitResult> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);
    return this.commitOf(ctx, kpm, text, invite);
  }

  /** The file's valid rows, as `commit` writes a paste's. */
  async commitFile(
    ctx: RequestContext, kpmId: string, file: FileUpload | undefined, invite = true,
  ): Promise<RosterCommitResult> {
    this.require(ctx);
    const kpm = await this.office(ctx, kpmId);
    return this.commitOf(ctx, kpm, await this.textOf(file), invite);
  }

  private async textOf(file: FileUpload | undefined): Promise<string> {
    if (!file) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.attachRosterFile, HttpStatus.BAD_REQUEST, { field: 'file' });
    }
    return rosterTextOf(file.buffer);
  }

  private async previewOf(ctx: RequestContext, kpm: KpmDocument, text: string): Promise<RosterPreview> {
    const parsed = parseRoster(text, this.todayIn(kpm), await this.codeRuleOf(kpm));
    if (parsed.issues.length > 0) return this.answer(ctx, parsed, []);
    return this.answer(ctx, parsed, await this.plan(ctx, kpm, parsed));
  }

  private async commitOf(ctx: RequestContext, kpm: KpmDocument, text: string, invite: boolean): Promise<RosterCommitResult> {
    // The whole file again: the commit does not trust a preview the caller may not have run (ADR-0205 §9).
    const parsed = parseRoster(text, this.todayIn(kpm), await this.codeRuleOf(kpm));
    if (parsed.issues.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        SAY.fileUnreadable,
        HttpStatus.BAD_REQUEST,
        // Each issue's words are written for the reader by the error filter; `details` holds the English.
        { issues: parsed.issues },
      );
    }
    const plans = await this.plan(ctx, kpm, parsed);
    if (!plans.some((p) => p.outcome !== 'skipped')) {
      throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.nothingToImport, HttpStatus.BAD_REQUEST, {
        skipped: plans.length,
      });
    }

    // An Owner or an Admin as themselves, so the history and audit rows name who did it (`office` has checked it is
    // theirs). A Super Admin wrote with the office named for them until P19.4-T2.
    const created = await this.write(ctx, kpm, plans);
    const invited = invite ? await this.invite(ctx, kpm, created) : 0;
    const shared = await this.inviteOnWhatsApp(ctx, plans);
    return { ...this.answer(ctx, parsed, plans, shared), invited };
  }

  /**
   * The rows' results, each written for the reader, and the skipped rows' file. `shared`: the invitations a commit made
   * on WhatsApp, by row (ADR-0250 §4).
   */
  private answer(
    ctx: RequestContext, parsed: ParsedRoster, plans: Plan[], shared = new Map<Plan, { link: string; phone: string }>(),
  ): RosterPreview {
    const say = (message: Message) => render(message, ctx.reader);
    const rows = plans.map((p): RosterRowView => ({
      line: p.row.line,
      agentCode: p.row.agentCode,
      fullName: p.row.fullName,
      role: p.row.role,
      leaderAgentCode: p.row.leaderAgentCode,
      email: p.row.email,
      outcome: p.outcome,
      messages: p.reasons.map(say),
      warnings: p.warnings.map(say),
      ...(shared.has(p) ? { invite: shared.get(p) } : {}),
    }));
    const skipped = plans.filter((p) => p.outcome === 'skipped');
    const count = (outcome: RosterOutcome) => plans.filter((p) => p.outcome === outcome).length;
    return {
      issues: parsed.issues.map((issue) => ({ ...issue, message: say(issue.message) })),
      header: parsed.header,
      counts: {
        imported: count('imported'), updated: count('updated'), invited: count('invited'), skipped: count('skipped'),
      },
      rows,
      skippedCsv: skipped.length === 0
        ? null
        : skippedRowsCsv(parsed.header, skipped.map((p) => ({ cells: p.row.cells, reason: p.reasons.map(say).join(' ') }))),
    };
  }

  // ------------------------------------------------------------------ deciding each row

  private async ladderOf(companyId: string): Promise<OrgLevelRow[]> {
    return (await this.orgLevels.laddersByCompany([companyId])).get(companyId) ?? [];
  }

  /** Everything a file is checked against, in a handful of reads: the office's members, the ladder, the accounts. */
  private async officeOf(kpm: KpmDocument, rows: RosterRow[]): Promise<Office> {
    const read = RequestContext.tenantRead(String(kpm._id), 'roster-import');
    const [ladder, live] = await Promise.all([
      this.ladderOf(kpm.companyId),
      this.members.find(read, { status: { $in: ['active', 'pending'] } }),
    ]);
    const names = new Map<string, OrgLevelRow>();
    for (const rung of [...ladder].reverse()) {
      for (const name of [rung.code, rung.label, shortOfRung(rung)]) names.set(name.trim().toLowerCase(), rung);
    }
    const byId = new Map(live.map((m) => [String(m._id), m]));
    const activeByCode = new Map(live.filter((m) => m.status === 'active').map((m) => [m.agentCode, m]));
    const codes = [...new Set(rows.map((r) => r.agentCode).filter(Boolean))];
    const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))];
    const updated = rows.map((r) => activeByCode.get(r.agentCode)).filter((m): m is MembershipDocument => Boolean(m));
    const [held, taken, accounts] = await Promise.all([
      codes.length ? this.users.find({ companyId: kpm.companyId, agentCode: { $in: codes }, deletedAt: null }).exec() : [],
      emails.length ? this.users.find({ email: { $in: emails }, deletedAt: null }).select('email').exec() : [],
      updated.length ? this.users.find({ _id: { $in: updated.map((m) => m.userId) } }).exec() : [],
    ]);
    return {
      kpm,
      ladder,
      rungOf: (typed) => names.get(typed.trim().toLowerCase()) ?? null,
      byId,
      activeByCode,
      heldByCode: new Map(held.map((u) => [String(u.agentCode), u])),
      emailTaken: new Set(taken.map((u) => u.email)),
      accounts: new Map(accounts.map((u) => [String(u._id), u])),
    };
  }

  /**
   * **What each row comes to** (A3's checks, in A3's order; ADR-0205 §5 to §7). The first reason found skips a row; the
   * upline checks are run over the whole file and the office until nothing more changes, so a row whose upline is
   * skipped is skipped too; then the leader limit, as the import has always checked it (P13.2-T4).
   */
  private async plan(ctx: RequestContext, kpm: KpmDocument, parsed: ParsedRoster): Promise<Plan[]> {
    const office = await this.officeOf(kpm, parsed.rows);
    const { ladder, rungOf, activeByCode, byId } = office;
    const classOf = (rung: OrgLevelRow): RoleClass => roleClassOf(tierOfRung(rung));
    const leaderRungs = ladder.filter((r) => isLeaderClass(classOf(r))).map(shortOfRung);
    const needingUpline = ladder.filter((r) => classOf(r) !== 'ab').map(shortOfRung);
    const ownerUserId = kpm.ownerUserId ?? null;

    const skip = (p: Plan, reason: Message) => { p.outcome = 'skipped'; p.reasons = [reason]; };

    const plans = parsed.rows.map((given): Plan => {
      const row = activeByCode.has(given.agentCode) ? forgivingEmail(given) : given;
      const plan: Plan = { row, outcome: 'imported', reasons: [], warnings: [], rung: null, existing: null, account: null };
      if (row.problems.length > 0) {
        plan.outcome = 'skipped';
        plan.reasons = row.problems.map((problem) => (problem.column === 'file'
          ? problem.message
          : ROW.cell({ column: problem.column, problem: render(problem.message, ctx.reader) })));
        return plan;
      }
      const existing = activeByCode.get(row.agentCode) ?? null;
      if (!existing) {
        // **A code held anywhere else at the insurer is skipped** (A-R3, OD-257's default): another office, a pending
        // or removed member here, an account in no office. Its holder is named only to whoever may know them (B1).
        const holder = office.heldByCode.get(row.agentCode);
        if (holder) {
          skip(plan, this.mayNameTheHolder(office, String(holder._id))
            ? SAY.agentCodeHeld({ email: holder.email })
            : SAY.agentCodeHeldElsewhere);
          return plan;
        }
      }
      const rung = rungOf(row.role);
      if (!rung) {
        skip(plan, ROW.roleNotOnLadder({ role: row.role, rungs: ladder.map(shortOfRung) }));
        return plan;
      }
      plan.rung = rung;
      if (existing) {
        plan.outcome = 'updated';
        plan.existing = existing;
        plan.account = office.accounts.get(existing.userId) ?? null;
        if (rung.code !== existing.orgLevelCode && ownerUserId !== null && existing.userId === ownerUserId) {
          skip(plan, ROW.ownerRole);
        }
      }
      return plan;
    });

    // The first row of a code stands for it; a later one is already skipped (*muncul dua kali*).
    const byCode = new Map<string, Plan>();
    for (const p of plans) if (p.row.agentCode && !byCode.has(p.row.agentCode)) byCode.set(p.row.agentCode, p);
    const leaderCodeOf = (m: MembershipDocument) => (m.leaderId ? byId.get(m.leaderId)?.agentCode ?? '' : '');
    const finalLeader = (p: Plan) => p.row.leaderAgentCode || (p.existing ? leaderCodeOf(p.existing) : '');
    const memberRung = (m: MembershipDocument): OrgLevelRow | null =>
      rungOf(m.orgLevelCode) ?? [...ladder].reverse().find((r) => classOf(r) === m.role) ?? null;
    const lookup = (code: string): Node => {
      const p = byCode.get(code);
      if (p && p.outcome !== 'skipped') return { code, rung: p.rung as OrgLevelRow, leader: finalLeader(p) };
      const m = activeByCode.get(code);
      if (m) {
        const rung = memberRung(m);
        return rung ? { code, rung, leader: leaderCodeOf(m) } : null;
      }
      return p ? 'skipped' : null;
    };
    const changes = (p: Plan) => !p.existing
      || (p.rung as OrgLevelRow).code !== p.existing.orgLevelCode
      || (p.row.leaderAgentCode !== '' && p.row.leaderAgentCode !== leaderCodeOf(p.existing));

    /*
     * **A leader moved onto a rung that leads nobody, while people still report to them**, is skipped — as a role change
     * refuses it (AC-3 of P3.1-T13). Counted before the upline checks, from who would report to them after the file:
     * the office's members under them that the file does not move, and the new people it puts under them.
     */
    for (const p of plans) {
      if (p.outcome === 'skipped' || !p.existing || isLeaderClass(classOf(p.rung as OrgLevelRow))) continue;
      const id = String(p.existing._id);
      const staying = [...activeByCode.values()].filter((m) => m.leaderId === id && !(
        byCode.get(m.agentCode)?.row.leaderAgentCode && byCode.get(m.agentCode)?.row.leaderAgentCode !== p.row.agentCode
      )).length;
      const arriving = plans.filter((q) => q !== p && !q.existing && q.row.leaderAgentCode === p.row.agentCode).length;
      if (staying + arriving > 0) skip(p, ROW.stillLeads({ count: staying + arriving }));
    }

    /** The first upline check a row fails (A-R4, A-R5; A3), or `null`. */
    const uplineProblem = (p: Plan): Message | null => {
      const rung = p.rung as OrgLevelRow;
      const code = p.row.agentCode;
      const up = finalLeader(p);
      if (!up) return classOf(rung) === 'ab' ? null : ROW.needsUpline({ rungs: needingUpline });
      if (up === code) return ROW.uplineLoop({ chain: [code, code] });
      const node = lookup(up);
      if (node === null) return ROW.uplineNotFound({ code: up });
      if (node === 'skipped') return ROW.uplineSkipped({ code: up });
      if (!isLeaderClass(classOf(node.rung))) return ROW.uplineNotALeader({ leaders: leaderRungs, rung: shortOfRung(node.rung) });
      if (node.rung.displayOrder < rung.displayOrder) {
        return ROW.uplineRanksLower({ upline: shortOfRung(node.rung), rung: shortOfRung(rung) });
      }
      // A loop (A → B → A), through the file and the office alike.
      const chain = [code, up];
      const seen = new Set(chain);
      let next = node.leader;
      while (next) {
        chain.push(next);
        if (next === code) return ROW.uplineLoop({ chain });
        if (seen.has(next)) break;
        seen.add(next);
        const above = lookup(next);
        next = above && above !== 'skipped' ? above.leader : '';
      }
      return null;
    };

    /*
     * Round by round: each round's problems are found against the rows as the round began, then applied — so both rows of
     * a loop are skipped for the loop, and a row under one of them for its upline's row, the round after.
     */
    const settle = () => {
      for (let changed = true; changed;) {
        const found = plans
          .filter((p) => p.outcome !== 'skipped' && changes(p))
          .map((p) => [p, uplineProblem(p)] as const)
          .filter((pair): pair is readonly [Plan, Message] => pair[1] !== null);
        for (const [p, problem] of found) skip(p, problem);
        changed = found.length > 0;
      }
    };
    settle();

    // **A new person's row needs an email** (ADR-0205 §7): an account signs in by it, and the invitation goes there —
    // or, for an Agent, a WhatsApp number, to be invited as *+ Tambah agent* invites (ADR-0250 §4).
    const byWhatsApp = await this.whatsAppRule(ctx, kpm, ladder, plans);
    for (const p of plans) {
      if (p.outcome !== 'imported') continue;
      if (p.row.email) {
        if (office.emailTaken.has(p.row.email)) skip(p, SAY.emailHasAccount);
        continue;
      }
      const why = byWhatsApp(p);
      if (why) skip(p, why);
      else p.outcome = 'invited';
    }
    settle();

    // **The leader limit** (ADR-0113 §2, P13.2-T4): each row past it skipped, in the file's order, with its words.
    const { max, used } = await this.seats(kpm);
    if (max !== null) {
      let leaders = used;
      for (const p of plans) {
        if (p.outcome === 'skipped' || !isLeaderClass(classOf(p.rung as OrgLevelRow))) continue;
        if (p.existing && isLeaderClass(p.existing.role)) continue;
        leaders += 1;
        if (leaders > max) skip(p, SAY.pastLimitForOffice({ max, used }));
      }
      settle();
    }

    // What importing or updating a row notes (A3, ADR-0205 §5 and §7), and what it leaves out (ADR-0250 §2, §3).
    for (const p of plans) {
      const cells = p.row.warnings.map((w) => ({ column: w.column, problem: render(w.message, ctx.reader) }));
      if (p.outcome === 'skipped') {
        // Nothing of a skipped row goes in, so a bad optional cell is one more thing to fix, said as a cell's problem.
        p.reasons.push(...cells.map((cell) => ROW.cell(cell)));
        continue;
      }
      p.warnings = cells.map((cell) => ROW.cellBlanked(cell));
      if (p.outcome === 'imported') {
        p.reasons = [];
        if (!p.row.phone) p.warnings.push(ROW.noWhatsApp);
        const missing = DETAILS.filter((field) => p.row[field] === null);
        if (missing.length > 0) p.warnings.push(ROW.missingDetails({ fields: headers(missing) }));
      } else if (p.outcome === 'updated') {
        p.reasons = [ROW.updated];
        if (p.row.email && p.account && p.row.email !== p.account.email) p.reasons.push(ROW.emailKept);
        if (p.row.phone && p.account?.phone && p.row.phone !== p.account.phone) p.reasons.push(ROW.phoneKept);
        const missing = DETAILS.filter((field) => p.row[field] === null && this.storedIsEmpty(p, field));
        if (missing.length > 0) p.warnings.push(ROW.missingDetails({ fields: headers(missing) }));
      } else {
        // Invited: registration asks the person for their own details, so a row's are not kept (ADR-0250 §4).
        p.reasons = [ROW.invitedByWhatsApp];
        const given = DETAILS.filter((field) => field !== 'joinDate' && p.row[field] !== null);
        if (given.length > 0) p.reasons.push(ROW.detailsAtRegistration({ fields: headers(given) }));
      }
    }
    return plans;
  }

  /**
   * Whether an update's member has nothing stored for one of their details (ADR-0250 §3): the membership's join date and
   * work status, the account's other three. An account that cannot be read is not reported on.
   */
  private storedIsEmpty(p: Plan, field: Detail): boolean {
    if (field === 'joinDate' || field === 'workStatus') return !p.existing?.[field];
    return p.account !== null && !p.account[field];
  }

  /**
   * **Whether a new person's row with no email can be invited on WhatsApp** (P19.12-T7 AC-4; ADR-0250 §4) — the reason it
   * cannot, or `null`. *+ Tambah agent*'s invitation (ADR-0170): the person joins at the ladder's entry rung, under a
   * leader, through a link to registration sent to their WhatsApp. So the row is the entry rung's (*Agent*), with a
   * number, and no invitation is already waiting for its code (`ORG_INVITE_PENDING`, as the form refuses it); its upline
   * has met the upline checks, which ask a leader of it. A reader who cannot invite (`member:invite`) is answered as
   * before ADR-0250, *Tanpa email*.
   */
  private async whatsAppRule(
    ctx: RequestContext, kpm: KpmDocument, ladder: OrgLevelRow[], plans: Plan[],
  ): Promise<(p: Plan) => Message | null> {
    const asking = plans.filter((p) => p.outcome === 'imported' && !p.row.email);
    if (asking.length === 0 || !this.invitations || !this.inviteRows || !can(ctx, 'member:invite')) return () => ROW.noEmail;
    const entry = await this.orgLevels.entryRungCode(kpm.companyId, 'joiner').catch(() => null);
    if (entry === null) return () => ROW.noEmail;
    const entryRung = ladder.find((rung) => rung.code === entry);
    const now = this.clock.now();
    const waiting = new Set<string>();
    for (const p of asking) {
      if (await this.inviteRows.pendingCodeAcrossTenants(kpm.companyId, p.row.agentCode, now)) waiting.add(p.row.agentCode);
    }
    return (p) => {
      if ((p.rung as OrgLevelRow).code !== entry) {
        return ROW.noEmailNotEntry({ entry: entryRung ? shortOfRung(entryRung) : entry });
      }
      if (!p.row.phone) return ROW.noEmailNoWhatsApp;
      if (waiting.has(p.row.agentCode)) return ONBOARDING_REFUSALS.ORG_INVITE_PENDING.waiting({ agentCode: p.row.agentCode });
      return null;
    };
  }

  /**
   * **Whether a skipped row may name who holds its code** (B1 of the T17–T20 permission review): about somebody with a
   * live membership in this very office. Anybody else is told the code is taken at the insurer, and nothing about whom —
   * an Owner who uploads sequential codes must not learn another office's people (ADR-0205 §6). (A Super Admin was told
   * who until P19.4-T2 took their grant.)
   */
  private mayNameTheHolder(office: Office, userId: string): boolean {
    return [...office.byId.values()].some((m) => m.userId === userId);
  }

  /** *Leaders used*, and the maximum, for the office being filled (ADR-0113, P13.2-T4); `max` `null` is no limit. */
  private async seats(kpm: KpmDocument): Promise<{ max: number | null; used: number }> {
    const max = kpm.subscription?.maxLeaders ?? null;
    if (max === null) return { max, used: 0 };
    const used = await countLeadersUsed(this.members, RequestContext.tenantRead(String(kpm._id), 'roster-import'));
    return { max, used };
  }

  // ------------------------------------------------------------------ writing, and undoing

  /** The rows still in, every upline's before the people under it (ADR-0205 §5: *rows are written leader first*). */
  private leaderFirst(plans: Plan[]): Plan[] {
    const live = plans.filter((p) => p.outcome !== 'skipped');
    const byCode = new Map(live.map((p) => [p.row.agentCode, p]));
    const done = new Set<Plan>();
    const ordered: Plan[] = [];
    const visit = (p: Plan, path: Set<Plan>) => {
      if (done.has(p) || path.has(p)) return;
      path.add(p);
      const up = byCode.get(p.row.leaderAgentCode);
      if (up) visit(up, path);
      done.add(p);
      ordered.push(p);
    };
    for (const p of live) visit(p, new Set());
    return ordered;
  }

  /**
   * **The writes, as one unit** (ADR-0205 §9). Each write that succeeds leaves its undo behind; if any write fails, the
   * undos run, newest first — the memberships, edges and accounts made are soft-deleted, an account's address freed for
   * the next import, and every member updated put back — and the failure is answered. The notices and audit rows of a
   * change are written only once everything has landed, so an undone import tells nobody anything happened.
   */
  private async write(scoped: RequestContext, kpm: KpmDocument, plans: Plan[]): Promise<Plan[]> {
    const at = this.clock.now();
    const undo: Array<() => Promise<unknown>> = [];
    const afterwards: Array<() => Promise<unknown>> = [];
    const created: Plan[] = [];
    /** Every active member's id by code, and each made here as it is made, so a row's upline resolves. */
    const idOf = new Map([...(await this.members.find(scoped, { status: 'active' }, { projection: { agentCode: 1 } }))]
      .map((m) => [m.agentCode, String(m._id)]));
    /*
     * **A password nobody holds**: the hash of a secret made here and dropped at once, one per commit (hashing is slow, and
     * a secret nobody has is no weaker for being shared). The person chooses their own through the invitation, or *Lupa
     * kata sandi?* — never a generated one read off a screen (ADR-0205 §10).
     */
    const unusable = await this.passwords.hash(this.passwords.generateToken());

    try {
      for (const plan of this.leaderFirst(plans)) {
        // Invited on WhatsApp: nothing is written here — the invitation is made once everything has landed.
        if (plan.outcome === 'invited') continue;
        if (plan.existing) await this.update(scoped, at, plan, idOf, undo, afterwards);
        else {
          await this.create(scoped, kpm, plan, idOf, unusable, undo);
          created.push(plan);
        }
      }
    } catch (err) {
      await this.undoAll(scoped, undo);
      await this.audit.record(scoped, {
        action: 'roster.import_undone',
        targetCollection: 'memberships',
        targetId: String(kpm._id),
        after: { writesUndone: undo.length, reason: err instanceof DomainException ? err.code : 'write_failed' },
      });
      throw err;
    }

    for (const step of afterwards) await step();
    await this.audit.record(scoped, {
      action: 'roster.imported',
      targetCollection: 'memberships',
      targetId: String(kpm._id),
      // Codes and counts, never a password and never a personal datum (PDP, UU 27/2022).
      after: {
        count: created.length,
        agentCodes: created.map((p) => p.row.agentCode),
        updated: plans.filter((p) => p.outcome === 'updated').map((p) => p.row.agentCode),
        // ADR-0250 §4: each invitation audits itself (`member_invite.created`) as it is made, after this.
        invitedOnWhatsApp: plans.filter((p) => p.outcome === 'invited').map((p) => p.row.agentCode),
        skipped: plans.filter((p) => p.outcome === 'skipped').length,
      },
    });
    return created;
  }

  /** Each undo, newest first. One that fails is logged and the rest still run: leave as little behind as can be left. */
  private async undoAll(scoped: RequestContext, undo: Array<() => Promise<unknown>>): Promise<void> {
    for (const step of [...undo].reverse()) {
      try {
        await step();
      } catch (err) {
        this.logger.error({ err, kpmId: scoped.kpmId }, 'a member import could not undo one of its writes');
      }
    }
  }

  /**
   * **A new person** (ADR-0205 §5, §10): an account and a membership, made together by `createWithAccount` once the
   * upline, the rung and the leader limit have been met with the lease held. An existing agent (ADR-0169 §6: nobody on a
   * roster is given an activation), joined on *Tanggal bergabung* or the import's day.
   */
  private async create(
    scoped: RequestContext, kpm: KpmDocument, plan: Plan, idOf: Map<string, string>, unusable: string,
    undo: Array<() => Promise<unknown>>,
  ): Promise<void> {
    const { row } = plan;
    const leaderId = row.leaderAgentCode ? idOf.get(row.leaderAgentCode) ?? null : null;
    const membership = await this.hierarchy.createWithAccount(scoped, {
      role: (plan.rung as OrgLevelRow).code,
      leaderId,
      status: 'active',
      workStatus: row.workStatus,
      joining: { joinedAs: 'existing_agent', ...(row.joinDate ? { joinDate: row.joinDate } : {}) },
    }, async () => {
      const account = await this.users.create({
        email: row.email,
        passwordHash: unusable,
        fullName: row.fullName,
        companyId: kpm.companyId,
        agentCode: row.agentCode,
        phone: row.phone,
        // ADR-0158: optional in an import; a blank one is completed on `/profile`, as an existing person's is.
        dateOfBirth: row.dateOfBirth,
        companyJoinMonth: row.companyJoinMonth,
        gender: row.gender,
        // Nobody holds this account's password, so there is none to replace: the invitation, or a reset, sets the first.
        mustChangePassword: false,
        // Proved when they open the invitation — or a reset link — from that mailbox (ADR-0190 §3).
        emailVerifiedAt: null,
        status: 'active',
        platformRole: 'none',
      });
      const userId = String(account._id);
      undo.push(async () => {
        // A membership the write made before it failed — the account's, in this office — goes with the account.
        for (const half of await this.members.find(scoped, { userId })) {
          await this.history.updateMany(scoped, { membershipId: String(half._id) }, { $set: { deletedAt: this.clock.now() } });
          await this.members.softDeleteById(scoped, String(half._id), this.clock.now());
        }
        // The address is freed for the next import, since the email index holds a deleted account's too.
        await this.users.updateOne(
          { _id: userId },
          { $set: { deletedAt: this.clock.now(), email: `undone+${userId}@roster-import.invalid` } },
        ).exec();
      });
      return userId;
    });
    const id = String(membership._id);
    idOf.set(row.agentCode, id);
    undo.push(async () => {
      await this.history.updateMany(scoped, { membershipId: id }, { $set: { deletedAt: this.clock.now() } });
      await this.members.softDeleteById(scoped, id, this.clock.now());
      await this.hierarchy.refreshCounts(scoped, leaderId);
    });
  }

  /**
   * **A code already in this office** (A3, *"Sudah ada; data diperbarui."*; ADR-0205 §5): each change through the path
   * the member page writes it by — the rung with an edge in the Role change log, the upline by closing one edge and
   * opening another (invariant §5), the number only where none is on file, the four fields of ADR-0158 and the join date
   * (ADR-0169 §2's correction: audited, reclassifying nobody). A blank cell keeps what is stored. **The email never.**
   */
  private async update(
    scoped: RequestContext, at: Date, plan: Plan, idOf: Map<string, string>,
    undo: Array<() => Promise<unknown>>, afterwards: Array<() => Promise<unknown>>,
  ): Promise<void> {
    const { row } = plan;
    const member = plan.existing as MembershipDocument;
    const rung = plan.rung as OrgLevelRow;
    const id = String(member._id);
    const changed: string[] = [];

    if (rung.code !== member.orgLevelCode) {
      const before = { orgLevelId: member.orgLevelId, orgLevelCode: member.orgLevelCode, role: member.role };
      const moved = await this.hierarchy.setLevel(scoped, id, rung.code);
      undo.push(async () => {
        await this.members.updateById(scoped, id, { $set: before });
        await this.hierarchy.refreshCounts(scoped, member.leaderId);
      });
      const edge = await this.history.openEdge(scoped, at, {
        membershipId: id,
        eventType: 'role_changed',
        fromRole: member.role,
        toRole: moved.role,
        fromOrgLevelId: member.orgLevelId,
        toOrgLevelId: moved.orgLevelId,
        toLeaderId: member.leaderId,
        reason: IMPORT_REASON,
      });
      undo.push(() => this.reopenEdgeBefore(scoped, id, edge));
      await this.hierarchy.refreshCounts(scoped, member.leaderId);
      changed.push('role');
      afterwards.push(() => this.notifications.send({
        userId: member.userId,
        kpmId: scoped.kpmId,
        templateId: NotificationTemplate.ROLE_CHANGED,
        payload: { fromRole: member.role, toRole: moved.role, reason: IMPORT_REASON },
      }));
    }

    const toLeader = row.leaderAgentCode ? idOf.get(row.leaderAgentCode) ?? null : member.leaderId;
    if (row.leaderAgentCode && toLeader !== member.leaderId) {
      const { previousLeaderId, moved } = await this.hierarchy.moveUnder(scoped, id, toLeader);
      if (moved) {
        undo.push(() => this.hierarchy.moveUnder(scoped, id, previousLeaderId));
        const after = await this.members.findById(scoped, id);
        const edge = await this.history.openEdge(scoped, at, {
          membershipId: id,
          eventType: 're_parented',
          fromLeaderId: previousLeaderId,
          toLeaderId: toLeader,
          toRole: after?.role ?? member.role,
          toOrgLevelId: after?.orgLevelId ?? member.orgLevelId,
          reason: IMPORT_REASON,
        });
        undo.push(() => this.reopenEdgeBefore(scoped, id, edge));
        changed.push('upline');
      }
    }

    // The membership's own: how they work here (ADR-0158 §1) and the day they joined (ADR-0169 §2).
    const membershipSet: Record<string, unknown> = {};
    const membershipBefore: Record<string, unknown> = {};
    if (row.workStatus && row.workStatus !== member.workStatus) {
      membershipSet.workStatus = row.workStatus;
      membershipBefore.workStatus = member.workStatus ?? null;
    }
    if (row.joinDate && row.joinDate !== member.joinDate) {
      membershipSet.joinDate = row.joinDate;
      membershipBefore.joinDate = member.joinDate ?? null;
    }
    if (Object.keys(membershipSet).length > 0) {
      await this.members.updateById(scoped, id, { $set: membershipSet });
      undo.push(() => this.members.updateById(scoped, id, { $set: membershipBefore }));
      changed.push(...Object.keys(membershipSet));
    }

    // The account's: the number only where none is on file (D-22, M1), and the three a person records (ADR-0158).
    const account = plan.account;
    if (account) {
      const userSet: Record<string, unknown> = {};
      const userBefore: Record<string, unknown> = {};
      const give = (field: 'dateOfBirth' | 'companyJoinMonth' | 'gender' | 'phone', value: string | null) => {
        if (value === null || value === (account[field] ?? null)) return;
        if (field === 'phone' && account.phone) return;
        userSet[field] = value;
        userBefore[field] = account[field] ?? null;
      };
      give('phone', row.phone);
      give('dateOfBirth', row.dateOfBirth);
      give('companyJoinMonth', row.companyJoinMonth);
      give('gender', row.gender);
      if (Object.keys(userSet).length > 0) {
        await this.users.updateOne({ _id: account._id }, { $set: userSet }).exec();
        undo.push(() => this.users.updateOne({ _id: account._id }, { $set: userBefore }).exec());
        changed.push(...Object.keys(userSet));
      }
    }

    afterwards.push(() => this.audit.record(scoped, {
      action: 'roster.member_updated',
      targetCollection: 'memberships',
      targetId: id,
      targetMembershipId: id,
      // Which fields, and the rung, upline and join date before and after — never a personal datum's value (PDP).
      before: {
        orgLevelCode: member.orgLevelCode, leaderId: member.leaderId, joinDate: member.joinDate ?? null,
      },
      after: {
        changed,
        orgLevelCode: rung.code,
        leaderId: toLeader,
        joinDate: row.joinDate ?? member.joinDate ?? null,
        ...(row.email && plan.account && row.email !== plan.account.email ? { emailNotApplied: true } : {}),
      },
    }));
  }

  /**
   * Undo one edge an import opened: soft-delete it, and reopen the edge it closed — the one whose `validTo` is the new
   * edge's `validFrom` — so the member is left with the one open edge they had (invariant §5).
   */
  private async reopenEdgeBefore(scoped: RequestContext, membershipId: string, edge: MembershipHistoryDocument): Promise<void> {
    await this.history.updateMany(scoped, { _id: edge._id }, { $set: { deletedAt: this.clock.now() } });
    await this.history.updateMany(
      scoped,
      { membershipId, validTo: edge.validFrom, _id: { $ne: edge._id } },
      { $set: { validTo: null } },
    );
  }

  /**
   * **The invitations** (ADR-0205 §10): to each new person, by email, a one-time link to choose their password — a
   * `password_reset` token the app's reset page consumes, alive for `ROSTER_INVITATION.TTL_DAYS`. Sent once everything
   * has landed. One that cannot be made is logged and the import stands: the person can still use *Lupa kata sandi?*.
   */
  private async invite(scoped: RequestContext, kpm: KpmDocument, created: Plan[]): Promise<number> {
    let invited = 0;
    for (const plan of created) {
      const userId = await this.users.findOne({ companyId: kpm.companyId, agentCode: plan.row.agentCode, deletedAt: null })
        .select('_id').exec().then((u) => (u ? String(u._id) : null));
      if (!userId) continue;
      try {
        const raw = this.passwords.generateToken();
        await this.tokens.create({
          userId,
          kind: 'password_reset',
          tokenHash: this.passwords.hashToken(raw),
          expiresAt: new Date(this.clock.now().getTime() + ROSTER_INVITATION.TTL_DAYS * 24 * 60 * 60_000),
        });
        await this.notifications.send({
          userId,
          kpmId: String(kpm._id),
          templateId: NotificationTemplate.MEMBER_INVITATION,
          payload: { token: raw, fullName: plan.row.fullName, office: kpm.branchName, days: ROSTER_INVITATION.TTL_DAYS },
        });
        // *Diundang* (ADR-0212 §2; P19.4-T3): the membership records when its invitation went.
        await this.members.updateMany(
          scoped, { userId, status: { $in: ['active', 'pending'] } }, { $set: { invitedAt: this.clock.now() } },
        );
        invited += 1;
      } catch (err) {
        this.logger.error({ err, kpmId: scoped.kpmId }, 'a member import could not send one invitation');
      }
    }
    if (invited > 0) {
      await this.audit.record(scoped, {
        action: 'roster.invited',
        targetCollection: 'users',
        targetId: String(kpm._id),
        after: { count: invited },
      });
    }
    return invited;
  }

  /**
   * **The invitations on WhatsApp** (P19.12-T7 AC-4; ADR-0250 §4): for each `invited` row, once everything else has
   * landed, *+ Tambah agent*'s own invitation (`InvitesService.addAgent`, ADR-0170) under the row's upline — its code
   * checked across the company, its join date the row's or the office's today, audited `member_invite.created`, and
   * listed on New Hires › *Menunggu bergabung* with *Kirim ulang*. Its link is answered once, for the reader to share.
   * **One that cannot be made skips its row**, with the refusal's words (an invitation that came to wait for the code
   * since the check, say); the rest of the import stands.
   */
  private async inviteOnWhatsApp(ctx: RequestContext, plans: Plan[]): Promise<Map<Plan, { link: string; phone: string }>> {
    const shared = new Map<Plan, { link: string; phone: string }>();
    const asked = plans.filter((p) => p.outcome === 'invited');
    if (asked.length === 0 || !this.invitations) return shared;
    const origin = this.config?.get<string>('APP_ORIGIN') ?? 'http://localhost:3000';
    for (const p of asked) {
      const { row } = p;
      try {
        const leader = await this.members.findOne(ctx, { agentCode: row.leaderAgentCode, status: 'active' });
        if (!leader) throw new NotFoundException('Membership');
        const made = await this.invitations.addAgent(ctx, {
          agentCode: row.agentCode,
          fullName: row.fullName,
          phone: row.phone as string,
          ...(row.joinDate ? { joinDate: row.joinDate } : {}),
          leaderMembershipId: String(leader._id),
        }, origin);
        if (made.outcome === 'invited') shared.set(p, { link: made.link, phone: made.invite.phone });
      } catch (err) {
        if (!(err instanceof DomainException)) {
          this.logger.error({ err, kpmId: ctx.kpmId }, 'a member import could not make one WhatsApp invitation');
        }
        p.outcome = 'skipped';
        p.reasons = [err instanceof DomainException ? err.sentence : ROW.inviteNotMade];
        p.warnings = [];
      }
    }
    return shared;
  }
}
