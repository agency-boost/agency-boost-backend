import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { DEFAULT_ORG_LADDER } from '@/domain/constants';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from './company.schema';
import { CompanyOrgLevel, CompanyOrgLevelDocument } from './company-org-level.schema';

/** One rung, as the console reads it. */
export interface OrgLevelRow {
  orgLevelId: string;
  companyId: string;
  code: string;
  label: string;
  displayOrder: number;
  status: 'active' | 'archived';
  archivedAt: string | null;
}

export interface CreateOrgLevelInput {
  companyId: string;
  code: string;
  label: string;
  displayOrder: number;
}

/** A rename or a reorder. The code is absent on purpose — see `update`. */
export interface UpdateOrgLevelInput {
  label?: string;
  displayOrder?: number;
  status?: 'active' | 'archived';
}

/**
 * The company role ladder (P3.5-T7, ADR-0012).
 *
 * Platform-level, like tenant provisioning: there is no tenant to scope to, so the
 * permission check is the only gate and it is explicit at the top of every method.
 */
@Injectable()
export class OrgLevelService {
  constructor(
    @InjectModel(CompanyOrgLevel.name)
    private readonly levels: Model<CompanyOrgLevelDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You do not have permission to do that.',
        HttpStatus.FORBIDDEN,
        { permission },
      );
    }
  }

  private static row(level: CompanyOrgLevelDocument): OrgLevelRow {
    return {
      orgLevelId: String(level._id),
      companyId: level.companyId,
      code: level.code,
      label: level.label,
      displayOrder: level.displayOrder,
      status: level.status,
      archivedAt: level.archivedAt ? level.archivedAt.toISOString() : null,
    };
  }

  /**
   * Every rung, junior first. **Archived ones included**, because a screen that hid them
   * would show a ladder that does not explain the people standing on it.
   */
  async list(ctx: RequestContext, companyId?: string): Promise<OrgLevelRow[]> {
    this.require(ctx, 'org_level:read');
    return (
      await this.levels
        .find({ deletedAt: null, ...(companyId ? { companyId } : {}) })
        .sort({ companyId: 1, displayOrder: 1 })
        .exec()
    ).map(OrgLevelService.row);
  }

  /** Every company's ladder as one map, for the callers that render several at once. */
  async laddersByCompany(companyIds: string[]): Promise<Map<string, OrgLevelRow[]>> {
    if (companyIds.length === 0) return new Map();
    const rows = await this.levels
      .find({ companyId: { $in: [...new Set(companyIds)] }, status: 'active', deletedAt: null })
      .sort({ displayOrder: 1 })
      .exec();

    const byCompany = new Map<string, OrgLevelRow[]>();
    for (const level of rows) {
      const list = byCompany.get(level.companyId) ?? [];
      list.push(OrgLevelService.row(level));
      byCompany.set(level.companyId, list);
    }
    return byCompany;
  }

  /**
   * The rungs a brand-new company starts with, from `DEFAULT_ORG_LADDER`.
   *
   * No permission check and no audit row: this is not somebody acting, it is part of
   * creating the company, which is audited as one event. Idempotent, so re-running the
   * demo seed neither duplicates nor throws.
   */
  async seedDefaultLadder(companyId: string): Promise<void> {
    for (const { code, label, displayOrder } of DEFAULT_ORG_LADDER) {
      const existing = await this.levels.findOne({ companyId, code, deletedAt: null }).exec();
      if (existing) continue;
      await this.levels.create({
        companyId, code, label, displayOrder,
        status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  /**
   * The rung a role name refers to, for the office's company.
   *
   * This is the join `memberships.orgLevelId` is written through. It resolves **active**
   * rungs only — putting somebody on a retired rung is not something the product should
   * be able to do quietly — and throws rather than returning null, because a membership
   * with no level is exactly the defect the reference exists to prevent and it would be
   * invisible until a screen tried to read it.
   */
  async resolveByCode(companyId: string, code: string): Promise<CompanyOrgLevelDocument> {
    const level = await this.levels
      .findOne({ companyId, code: code.toUpperCase(), status: 'active', deletedAt: null })
      .exec();
    if (!level) {
      throw new DomainException(
        ErrorCode.ORG_LEVEL_NOT_ON_LADDER,
        `No active level with the code ${code.toUpperCase()} on this company's ladder.`,
        HttpStatus.CONFLICT,
        { companyId, code: code.toUpperCase() },
      );
    }
    return level;
  }

  async create(ctx: RequestContext, input: CreateOrgLevelInput): Promise<OrgLevelRow[]> {
    this.require(ctx, 'org_level:crud');

    const company = await this.companies
      .findOne({ _id: input.companyId, deletedAt: null })
      .exec();
    if (!company) throw new NotFoundException('Company');

    const code = input.code.trim().toUpperCase();
    // Archived rows count. A retired code that could be recreated as a different rung
    // would change what every membership pointing at the old one means.
    const clash = await this.levels
      .findOne({ companyId: input.companyId, code, deletedAt: null })
      .exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.ORG_LEVEL_CODE_TAKEN,
        `${company.name} already has a level with the code ${code}` +
          (clash.status === 'archived' ? ', archived. An archived code is never reused.' : '.'),
        HttpStatus.CONFLICT,
        { companyId: input.companyId, code, status: clash.status },
      );
    }

    const level = await this.levels.create({
      companyId: input.companyId,
      code,
      label: input.label.trim(),
      displayOrder: input.displayOrder,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
    });

    await this.audit.record(ctx, {
      action: 'org_level.created',
      targetCollection: 'companyOrgLevels',
      targetId: String(level._id),
      after: { companyId: level.companyId, code: level.code, label: level.label, displayOrder: level.displayOrder },
    });

    return this.list(ctx, input.companyId);
  }

  /**
   * Rename, reorder, or archive.
   *
   * **The code is not updatable, at all.** It is the identity every membership and every
   * history row holds, and invariant 3 says it never changes once published. Renaming is
   * what `label` is for; a genuinely different rung is a new level.
   */
  async update(
    ctx: RequestContext,
    orgLevelId: string,
    input: UpdateOrgLevelInput,
  ): Promise<OrgLevelRow[]> {
    this.require(ctx, 'org_level:crud');

    const level = await this.levels.findOne({ _id: orgLevelId, deletedAt: null }).exec();
    if (!level) throw new NotFoundException('Org level');

    const before = { label: level.label, displayOrder: level.displayOrder, status: level.status };

    if (input.label !== undefined) level.label = input.label.trim();
    if (input.displayOrder !== undefined) level.displayOrder = input.displayOrder;
    if (input.status !== undefined && input.status !== level.status) {
      level.status = input.status;
      // Archiving stamps the date; un-archiving clears it, so the field always answers
      // "when did this stop being offered" rather than "when was it last touched".
      level.archivedAt = input.status === 'archived' ? this.clock.now() : null;
    }
    await level.save();

    await this.audit.record(ctx, {
      action: input.status === 'archived' ? 'org_level.archived' : 'org_level.updated',
      targetCollection: 'companyOrgLevels',
      targetId: String(level._id),
      before,
      after: { label: level.label, displayOrder: level.displayOrder, status: level.status },
    });

    return this.list(ctx, level.companyId);
  }
}
