import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { ProposalBranding } from './proposal-branding';
import { ProposalPdfBuilder, ProposalPdfTooLong } from './proposal-pdf.builder';
import { dispositionOf, proposalFileName } from './proposal-pdf.layout';
import { pdfModelOf, type PdfModelInput } from './proposal-pdf.model';
import { ProposalService } from './proposal.service';

/** The file a route answers: its bytes, its `Content-Disposition`, and how many pages it has. */
export interface ProposalPdfFile { bytes: Buffer; disposition: string; pages: number }

/**
 * **`GET /proposals/:proposalId/pdf`: the file, built from the data each time and kept nowhere** (P19.7-T3; ADR-0222;
 * *redrawn 2026-11-12 by P19.14-T3, ADR-0256*).
 *
 * - **The caller's own proposal, or `404 PROPOSAL_NOT_FOUND`** — the same lookup every proposal route makes, so another
 *   member's, another KPM's and a deleted one answer alike (ADR-0221 §2). A view-only session never reaches here: the
 *   guard refuses `proposal:download` (`403 PERM_DENIED`).
 * - **A *Draf* is built too**: the preview shows its pages before *Simpan PDF* finishes it. Nothing here changes it.
 * - **Read now, never kept** (ADR-0222 §2): the agent's name and phone (`users`) and agent code (`memberships`), the
 *   KPM's name, its company's name for the disclaimer, and the KPM's branding as it shows today — so a download again
 *   after the KPM changes its branding carries the new one. The proposal becomes the file's model
 *   (`proposal-pdf.model.ts`), the model its pages (`proposal-pdf.layout.ts`); the bytes are built in memory and
 *   returned, and no disk, bucket, cache or log holds them.
 * - **Audited as `proposal.pdf_built`**: the proposal, its item count and page count, no name; failing open.
 */
@Injectable()
export class ProposalPdfService {
  private readonly logger = new Logger(ProposalPdfService.name);

  constructor(
    private readonly proposals: ProposalService,
    private readonly builder: ProposalPdfBuilder,
    private readonly branding: ProposalBranding,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // Global identity, the office and its company: read for a few words on the page, never written.
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
  ) {}

  async pdf(ctx: RequestContext, id: string): Promise<ProposalPdfFile> {
    const proposal = await this.proposals.read(ctx, id);
    const [agent, office, branding] = await Promise.all([this.agentOf(ctx), this.officeOf(ctx), this.branding.of(ctx)]);
    const input: PdfModelInput = { proposal, agent, insurer: office.insurer, kpmName: office.name, branding };
    let built;
    try {
      built = await this.builder.build(pdfModelOf(input), this.clock.now());
    } catch (err) {
      // A bound raised without the worst-case test: logged with the proposal's id and no name, answered `500`.
      if (err instanceof ProposalPdfTooLong) this.logger.error(`proposal ${proposal.id}: ${err.message}`);
      throw err;
    }
    await this.recordBuilt(ctx, proposal.id, proposal.items.length, built.pages);
    return { bytes: built.bytes, disposition: dispositionOf(proposalFileName(proposal.client.name, proposal.date)), pages: built.pages };
  }

  /** The agent, as their profile and membership hold them now. A part they lack is `null`, and the page leaves it out. */
  private async agentOf(ctx: RequestContext): Promise<PdfModelInput['agent']> {
    const membership = ctx.membershipId ? await this.memberships.findOne(ctx, { _id: ctx.membershipId }) : null;
    const userId = membership?.userId ?? ctx.userId;
    const user = isValidObjectId(userId)
      ? await this.users.findOne({ _id: userId }, { fullName: 1, phone: 1, agentCode: 1 }).lean().exec()
      : null;
    return {
      name: user?.fullName?.trim() || null,
      code: membership?.agentCode?.trim() || user?.agentCode?.trim() || null,
      phone: user?.phone?.trim() || null,
    };
  }

  /** The KPM's name (the file's author) and its company's (the disclaimer's insurer). */
  private async officeOf(ctx: RequestContext): Promise<{ name: string; insurer: string }> {
    const kpm = ctx.kpmId ? await this.kpms.findOne({ _id: ctx.kpmId }, { branchName: 1, companyId: 1 }).lean().exec() : null;
    const company = kpm?.companyId && isValidObjectId(kpm.companyId)
      ? await this.companies.findOne({ _id: kpm.companyId }, { name: 1 }).lean().exec()
      : null;
    return { name: kpm?.branchName ?? '', insurer: company?.name ?? '' };
  }

  private async recordBuilt(ctx: RequestContext, id: string, items: number, pages: number): Promise<void> {
    try {
      await this.audit.record(ctx, { action: 'proposal.pdf_built', targetCollection: 'proposals', targetId: id, after: { items, pages } });
    } catch (err) {
      this.logger.warn(`proposal.pdf_built not recorded for ${id}: ${(err as Error).message}`);
    }
  }
}
