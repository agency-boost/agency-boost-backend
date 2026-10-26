import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException, VersionConflictException } from '@/common/errors/domain.exception';
import { RECRUITMENT, type RecruitmentPlaybookBody } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { checkPlaybookBody } from './recruitment-playbook-input';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';
import { recruitmentVocabulary, type RecruitmentVocabulary } from './recruitment-plan';
import { RecruitmentPlaybook, RecruitmentPlaybookDocument } from './recruitment-playbook.schema';

/** A company's playbook as the console reads it (`PlaybookDto`). */
export interface PlaybookView {
  companyId: string;
  version: number;
  body: RecruitmentPlaybookBody;
  updatedAt: string;
  /** The Super Admin who saved it last, by name; `null` for the words the company was given. */
  updatedBy: { name: string } | null;
}

/** `GET /admin/companies/:companyId/recruitment-playbook`. */
export interface PlaybookAdminView {
  playbook: PlaybookView | null;
  /** The AgencyBoost words, for *Start from the AgencyBoost words* (T8 AC-1). */
  defaults: RecruitmentPlaybookBody;
  vocabulary: RecruitmentVocabulary;
  /** The bounds a save is held to, served so the editor never re-declares them (invariant §7). */
  limits: { textMax: number; benefitsMax: number };
}

/**
 * **A company's recruitment playbook** (OD-88 → option 5, ADR-0125; D-model, T2 AC-1, T8).
 *
 * **Company-partitioned, as `products` is** (ADR-0033): no `kpmId`, so no tenant-scoped repository — the
 * filter that matters is `companyId`, applied for every read in **one named method**, {@link ofCompany},
 * and on every write inline beside it. An office's plan reads its own company's row through it, by the
 * company its office belongs to, never one a caller names; the console reads and writes the company in its
 * address, as the Super Admin's.
 *
 * Given **version 1, the AgencyBoost words**, when a company is created from the defaults
 * (`TenantService.createCompany`, beside products and carrier rules; ADR-0115 §1); a blank company is given
 * none. Migration `0025` gives it to the companies that predate it.
 */
@Injectable()
export class RecruitmentPlaybookService {
  constructor(
    @InjectModel(RecruitmentPlaybook.name) private readonly playbooks: Model<RecruitmentPlaybookDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * **The company filter for every read** — the named company-filtered method (ADR-0033): the one live
   * playbook of this company, or `null` for a company that has none (a blank one, ADR-0115).
   */
  async ofCompany(companyId: string): Promise<RecruitmentPlaybookDocument | null> {
    return this.playbooks.findOne({ companyId, deletedAt: null }).exec();
  }

  /**
   * **Version 1 of the AgencyBoost words, for a company started from the defaults** (T2 AC-3). A company
   * that has a playbook already is left alone, so running it twice changes nothing. `true` when it wrote.
   */
  async seedForCompany(companyId: string): Promise<boolean> {
    if (await this.ofCompany(companyId)) return false;
    await this.playbooks.create({
      companyId, body: defaultPlaybookBody(), version: 1, updatedBy: null, createdBy: null, deletedAt: null,
    });
    return true;
  }

  /**
   * **A new company's playbook, copied from another company's** (ADR-0164 §4): the Template library's words as
   * the new company's version 1. A copy, never a link: rewording either afterwards is that company's alone. A
   * source with no playbook gives none; a company that has one is left alone. `true` when it wrote.
   */
  async copyFromCompany(sourceCompanyId: string, companyId: string): Promise<boolean> {
    if (await this.ofCompany(companyId)) return false;
    const source = await this.ofCompany(sourceCompanyId);
    if (!source) return false;
    await this.playbooks.create({
      companyId, body: structuredClone(source.toObject().body), version: 1, updatedBy: null, createdBy: null, deletedAt: null,
    });
    return true;
  }

  /** `GET /admin/companies/:companyId/recruitment-playbook`: the company's playbook or none, and the defaults. */
  async readForAdmin(companyId: string): Promise<PlaybookAdminView> {
    await this.requireCompany(companyId);
    const row = await this.ofCompany(companyId);
    return {
      playbook: row ? await this.view(row) : null,
      defaults: defaultPlaybookBody(),
      vocabulary: recruitmentVocabulary(),
      limits: { textMax: RECRUITMENT.TEXT_MAX_LENGTH, benefitsMax: RECRUITMENT.BENEFITS_MAX },
    };
  }

  /**
   * `PUT /admin/companies/:companyId/recruitment-playbook` (T8 AC-2): the whole playbook in one write,
   * **pinned to its version** — `null` only to create the company's first, else the version read — checked
   * whole first, audited with what it replaced. Every office of the company reads it on its next plan.
   */
  async save(
    ctx: RequestContext, companyId: string, input: { version: number | null; body: unknown },
  ): Promise<PlaybookView> {
    await this.requireCompany(companyId);
    const body = checkPlaybookBody(input.body);

    if (input.version === null) {
      const existing = await this.ofCompany(companyId);
      if (existing) throw new VersionConflictException(0, existing.version);
      const created = await this.playbooks.create({
        companyId, body, version: 1, updatedBy: ctx.userId, createdBy: ctx.userId, deletedAt: null,
      }).catch(async (err: { code?: number }) => {
        // Two Super Admins creating the company's first at once: the unique index refuses the second,
        // which is the same conflict the check above answers the one who was not first.
        if (err.code !== 11000) throw err;
        throw new VersionConflictException(0, (await this.ofCompany(companyId))?.version ?? 0);
      });
      await this.record(ctx, { id: String(created._id), version: 1 }, companyId, null, body);
      return this.view(created);
    }

    const previous = await this.playbooks.findOneAndUpdate(
      { companyId, version: input.version, deletedAt: null },
      { $set: { body, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { new: false },
    ).exec();
    if (!previous) {
      throw new VersionConflictException(input.version, (await this.ofCompany(companyId))?.version ?? 0);
    }
    // The version this write made is the one it replaced plus one — never a re-read, which a later save
    // could already have moved (the Phase 17 exit review).
    await this.record(ctx, { id: String(previous._id), version: previous.version + 1 }, companyId, previous, body);
    return this.view((await this.ofCompany(companyId))!);
  }

  // -------------------------------------------------------------------- internals

  private async requireCompany(companyId: string): Promise<void> {
    // A malformed id from the address is "not here", not a 500.
    const company = isValidObjectId(companyId)
      ? await this.companies.findOne({ _id: companyId, deletedAt: null }).select('_id').lean().exec()
      : null;
    if (!company) throw new NotFoundException('Company');
  }

  /** `recruitment_playbook.saved`: the words before and after, and the versions, by the Super Admin. */
  private record(
    ctx: RequestContext, written: { id: string; version: number }, companyId: string,
    previous: RecruitmentPlaybookDocument | null, body: RecruitmentPlaybookBody,
  ) {
    return this.audit.record(ctx, {
      action: 'recruitment_playbook.saved',
      targetCollection: 'recruitmentPlaybooks',
      targetId: written.id,
      before: previous ? { version: previous.version, body: previous.body } : null,
      after: { companyId, version: written.version, body },
    });
  }

  private async view(row: RecruitmentPlaybookDocument): Promise<PlaybookView> {
    const user = row.updatedBy && isValidObjectId(row.updatedBy)
      ? await this.users.findById(row.updatedBy).select('fullName').lean().exec()
      : null;
    return {
      companyId: row.companyId,
      version: row.version,
      body: row.body,
      updatedAt: (row as unknown as { updatedAt: Date }).updatedAt.toISOString(),
      updatedBy: user ? { name: (user as { fullName: string }).fullName } : null,
    };
  }
}
