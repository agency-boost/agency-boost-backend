import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { DEFAULT_TENANT_TIMEZONE, KPM_REPORT } from '@/domain/constants';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { AuditService } from '@/modules/audit/audit.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { dispositionOf } from '@/modules/proposals/proposal-pdf.layout';
import { can } from '@/modules/rbac/permissions';
import { shiftMonth } from '@/modules/reporting/office-figures';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { KpmReportBuilder } from './kpm-report.builder';
import { reportFileName } from './kpm-report.layout';
import { ReportLinkSigner } from './kpm-report.link';
import { KPM_REPORT_REFUSALS } from './kpm-report.messages';
import { KpmReportReadings, type ReportOffice } from './kpm-report.readings';
import type { KpmReportLinkViewDto } from './kpm-report.response.dto';
import { monthLong } from './kpm-report.words';

/** The file a route answers: its bytes, its `Content-Disposition`, and how many pages it has. */
export interface KpmReportFile { bytes: Buffer; disposition: string; pages: number }

/** The audit actions the report writes (labelled in `audit-labels.messages.ts`). */
export const KPM_REPORT_ACTIONS = {
  built: 'kpm_report.built',
  linkMade: 'kpm_report.link_made',
  linkOpened: 'kpm_report.link_opened',
} as const;

/** One office as `kpms` holds it, for the report's first lines. */
interface OfficeRow { _id: unknown; branchName: string; code: string; companyId: string; timezone?: string; ownerUserId: string | null; pendingOwner?: { fullName: string; phone?: string | null } | null }

/**
 * **The KPM report** (P19.24-T1, T2; [ADR-0280](../../../../docs/04-adr/0280-the-kpm-report-is-one-pdf-built-on-the-server-from-the-pages-own-readings.md)):
 * the Super Admin's *Unduh PDF* and *Kirim ke owner* for any KPM and month, and the Owner opening the link.
 *
 * - **The Super Admin's, as themselves** (§6): `kpm_report:read`, the route's guard first and this second — a Super
 *   Admin outside any session. **Any KPM of any company**, live (not soft-deleted); an unknown one is `404`.
 * - **The month**: the KPM's own month (`kpms.timezone`, invariant §9) or one of the `KPM_REPORT.MONTHS_BACK` before it;
 *   any other `400 VALIDATION_FAILED`.
 * - **Read as the KPM's Owner sees it** (§2): `RequestContext.superAdminInKpm` — every figure the page's own reading
 *   (`KpmReportReadings`), test accounts never counted; built in memory and kept nowhere (`KpmReportBuilder`).
 * - **Every report made is audited** (P19.24-T2 AC-2): `kpm_report.built` (*Unduh PDF*), `kpm_report.link_made` and
 *   `kpm_report.link_opened`, each in the platform's log and the KPM's, **written before the file is sent — a failure
 *   fails the request**; and, as the KPM Overview records it, the §3.5 subject read of every person listed (surface
 *   `kpm_overview`, failing open).
 * - **The link** (§5; OD-359, OD-428): no message is sent by the app — the Super Admin's own WhatsApp carries it. It opens
 *   for the KPM's Owner or a KPM Admin, signed in, in that KPM (`kpm_report:download_link`), for `LINK_TTL_DAYS`, while
 *   its maker is still a Super Admin; the file is built again when it is opened, as the maker's.
 */
@Injectable()
export class KpmReportService {
  private readonly signer: ReportLinkSigner;
  private readonly appOrigin: string;

  constructor(
    // The office's row, its company and its Owner: global and platform rows, read by id for a few words on the page.
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly readings: KpmReportReadings,
    private readonly builder: KpmReportBuilder,
    private readonly audit: AuditService,
    private readonly subjectReads: SubjectReadAudit,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.signer = new ReportLinkSigner(config.get<string>('JWT_ACCESS_SECRET') ?? '');
    this.appOrigin = (config.get<string>('APP_ORIGIN') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** **`GET /admin/tenants/:id/report?month=`** — *Unduh PDF*. */
  async pdf(ctx: RequestContext, kpmId: string, month: string): Promise<KpmReportFile> {
    this.requireSuperAdmin(ctx);
    const row = await this.officeRow(kpmId);
    this.requireMonth(row, month);
    const office = await this.officeOf(row);
    const inKpm = RequestContext.superAdminInKpm(ctx, kpmId);
    const built = await this.make(inKpm, office, month);
    await this.audit.recordInScopesOrFail(ctx, this.inBothLogs(kpmId, {
      action: KPM_REPORT_ACTIONS.built, month, pages: built.pages, people: built.people,
    }));
    await this.subjectReads.recordMany(inKpm, built.subjects, 'kpm_overview', { from: null, to: built.asOf });
    return { bytes: built.bytes, disposition: dispositionOf(reportFileName(office.name, month)), pages: built.pages };
  }

  /** **`POST /admin/tenants/:id/report/link`** — *Kirim ke owner*: the link, and what the WhatsApp message names. */
  async link(ctx: RequestContext, kpmId: string, month: string): Promise<KpmReportLinkViewDto> {
    this.requireSuperAdmin(ctx);
    const row = await this.officeRow(kpmId);
    this.requireMonth(row, month);
    const office = await this.officeOf(row);
    const { token, claims } = this.signer.sign({ kpmId, month, userId: ctx.auditActors.actorUserId }, this.clock.now());
    const expiresAt = new Date(claims.expiresAt * 1000).toISOString();
    await this.audit.recordInScopesOrFail(ctx, this.inBothLogs(kpmId, {
      action: KPM_REPORT_ACTIONS.linkMade, month, linkId: claims.linkId, expiresAt,
    }));
    const owner = await this.ownerOf(row);
    return {
      link: `${this.appOrigin}/laporan-kpm/${token}`,
      month,
      expiresAt,
      kpmName: office.name,
      kpmCode: office.code,
      companyName: office.company,
      ownerName: owner.name,
      ownerPhone: owner.phone,
    };
  }

  /**
   * **`GET /kpm-report/shared/:token`** — the Owner (or a KPM Admin) opening the link, signed in. A link that opens
   * nothing — altered, expired, its maker no longer a Super Admin, its KPM gone — is `404` saying which; a reader of
   * another KPM is `404` too, never confirming the report.
   */
  async openLink(ctx: RequestContext, token: string): Promise<KpmReportFile> {
    this.limit(ctx);
    const claims = this.signer.open(token, this.clock.now());
    if (ctx.isImpersonating) throw new PermissionDeniedException('kpm_report:download_link');
    const member = ctx.membership;
    if (ctx.kpmId !== claims.kpmId || !member || member.status !== 'active' || !(member.isKpmOwner || member.isKpmAdmin)) {
      throw new DomainException(ErrorCode.NOT_FOUND, KPM_REPORT_REFUSALS.NOT_FOUND.notYourKpm, HttpStatus.NOT_FOUND);
    }
    const maker = isValidObjectId(claims.userId)
      ? await this.users.findOne({ _id: claims.userId, deletedAt: null, platformRole: 'super_admin' }, { _id: 1 }).lean().exec()
      : null;
    if (!maker) throw new DomainException(ErrorCode.NOT_FOUND, KPM_REPORT_REFUSALS.NOT_FOUND.linkNotValid, HttpStatus.NOT_FOUND);
    const row = await this.officeRow(claims.kpmId);
    const office = await this.officeOf(row);
    // Built as the Super Admin who sent it would build it, inside the KPM: the same report, read again now.
    const asMaker = RequestContext.superAdminInKpm(RequestContext.platform(claims.userId).withReader(ctx.reader), claims.kpmId);
    const built = await this.make(asMaker, office, claims.month);
    await this.audit.recordInScopesOrFail(ctx, this.inBothLogs(claims.kpmId, {
      action: KPM_REPORT_ACTIONS.linkOpened, month: claims.month, linkId: claims.linkId, madeBy: claims.userId, pages: built.pages,
    }));
    await this.subjectReads.recordMany(ctx, built.subjects, 'kpm_overview', { from: null, to: built.asOf });
    return { bytes: built.bytes, disposition: dispositionOf(reportFileName(office.name, claims.month)), pages: built.pages };
  }

  // ---------------------------------------------------------------------------------------------- parts

  private async make(ctx: RequestContext, office: ReportOffice, month: string) {
    const model = await this.readings.read(ctx, office, month);
    const file = await this.builder.build(model, this.clock.now());
    return {
      bytes: file.bytes,
      pages: file.pages,
      people: model.people.length,
      asOf: model.asOf,
      subjects: model.people.map((p) => ({ membershipId: p.membershipId })),
    };
  }

  /** The route's guard has asked; this is the second wall (ADR-0207 §1): a Super Admin, as themselves. */
  private requireSuperAdmin(ctx: RequestContext): void {
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, 'kpm_report:read')) throw new PermissionDeniedException('kpm_report:read');
  }

  /** A live KPM by id — any company's — or `404`: an unknown id and a deleted KPM are alike. */
  private async officeRow(kpmId: string): Promise<OfficeRow> {
    const row = isValidObjectId(kpmId)
      ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }, { branchName: 1, code: 1, companyId: 1, timezone: 1, ownerUserId: 1, pendingOwner: 1 })
        .lean().exec() as OfficeRow | null
      : null;
    if (!row) throw new NotFoundException('KPM');
    return row;
  }

  /** **The months a report is made for** (`KPM_REPORT.MONTHS_BACK`): the KPM's month back to twelve before it. */
  private requireMonth(row: OfficeRow, month: string): void {
    const current = this.clock.localDateFor(row.timezone ?? DEFAULT_TENANT_TIMEZONE).slice(0, 7);
    const earliest = shiftMonth(current, -KPM_REPORT.MONTHS_BACK);
    if (month > current || month < earliest) {
      throw new InvalidRequestException(
        KPM_REPORT_REFUSALS.VALIDATION_FAILED.monthOutOfRange({ earliest: monthLong(earliest), latest: monthLong(current) }),
        { field: 'month', earliest, latest: current },
      );
    }
  }

  private async officeOf(row: OfficeRow): Promise<ReportOffice> {
    const [company, owner] = await Promise.all([
      isValidObjectId(row.companyId) ? this.companies.findOne({ _id: row.companyId }, { name: 1 }).lean().exec() as Promise<{ name?: string } | null> : null,
      this.ownerOf(row),
    ]);
    return { kpmId: String(row._id), name: row.branchName, company: company?.name ?? '', code: row.code, ownerName: owner.name };
  }

  /** The Owner's name and WhatsApp number: the account's, or the named Owner who waits (`pendingOwner`). */
  private async ownerOf(row: OfficeRow): Promise<{ name: string | null; phone: string | null }> {
    const owner = row.ownerUserId && isValidObjectId(row.ownerUserId)
      ? await this.users.findOne({ _id: row.ownerUserId, deletedAt: null }, { fullName: 1, phone: 1 }).lean().exec() as { fullName?: string; phone?: string | null } | null
      : null;
    if (owner) return { name: owner.fullName ?? null, phone: owner.phone ?? null };
    return { name: row.pendingOwner?.fullName ?? null, phone: row.pendingOwner?.phone ?? null };
  }

  /** One entry in the platform's log and one in the KPM's (ADR-0207 §5): the same action, the KPM named. */
  private inBothLogs(kpmId: string, after: { action: string } & Record<string, unknown>) {
    const { action, ...rest } = after;
    const entry = { action, targetCollection: 'kpms', targetId: kpmId, after: rest };
    return [{ kpmId: null, entry }, { kpmId, entry }];
  }

  /** At most `LINK_OPENS_PER_HOUR` opens an hour per account: a link is no way to make the API build reports in a loop. */
  private limit(ctx: RequestContext): void {
    const retryAfter = this.limiter.check(`kpm-report-link:${ctx.userId}`, KPM_REPORT.LINK_OPENS_PER_HOUR, 60 * 60);
    if (retryAfter === null) return;
    throw new DomainException(
      ErrorCode.AUTH_RATE_LIMITED,
      KPM_REPORT_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds: retryAfter },
    );
  }
}
