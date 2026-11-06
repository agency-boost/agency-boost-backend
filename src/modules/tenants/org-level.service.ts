import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import {
  DEFAULT_ORG_LADDER, roleClassOf, tierOfRung, type LeaderTier, type RoleClass,
} from '@/domain/constants';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import { Company, CompanyDocument } from './company.schema';
import { Kpm, KpmDocument } from './kpm.schema';
import { CompanyOrgLevel, CompanyOrgLevelDocument } from './company-org-level.schema';
import { OrgLevelReferenceSearch, type OrgLevelReference } from './org-level-references.port';
import { TENANTS_REFUSALS } from './tenants.messages';

/** One rung, as the console reads it. */
export interface OrgLevelRow {
  orgLevelId: string;
  companyId: string;
  code: string;
  label: string;
  displayOrder: number;
  /** *Senior Leader*, *Associate Leader* or `null` — *Not a leader* (ADR-0156). */
  leaderTier: LeaderTier | null;
  status: 'active' | 'archived';
  archivedAt: string | null;
  /** Moves on every write of the rung (P19-T6): what `expectedVersion` is checked against. */
  version: number;
}

export interface CreateOrgLevelInput {
  companyId: string;
  code: string;
  label: string;
  displayOrder: number;
  /** Absent is *Not a leader*: a new rung leads only when the Super Admin says so. */
  leaderTier?: LeaderTier | null;
}

/** A rename, a reorder, an archive or a tier. The code is absent on purpose — see `update`. */
export interface UpdateOrgLevelInput {
  label?: string;
  displayOrder?: number;
  /** `null` is *Not a leader*; absent leaves the tier as it is. */
  leaderTier?: LeaderTier | null;
  status?: 'active' | 'archived';
  /** The rung's `version` as read (P19-T6 AC-2). Sent, one the rung has moved past is `409`; absent, unchecked. */
  expectedVersion?: number;
}

/**
 * **A rung at one version, as a write's filter** — a rung written raw, as migration 0037 writes the Template's, has
 * no version key and reads as `0`, so version `0` matches it by the field's absence too.
 */
const atVersion = (version: number): Record<string, unknown> => (version === 0
  ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
  : { version });

/**
 * The company role ladder (P3.1-T7, ADR-0012).
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
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    /**
     * Who stands on a rung, for the refusal of a tier change while anybody does (ADR-0156 §5) — and for nothing
     * else. `@Optional` only because fifteen specs build this service by hand for the ladder reads and never
     * change a tier; the one write that needs it refuses as a server fault without it, rather than re-classing
     * people unchecked (`requireHolders`). The application module always provides it.
     */
    @Optional() private readonly members?: MembershipRepository,
    /**
     * What names a rung, for its delete (ADR-0213 §2) — and for nothing else. `@Optional` for `members`' reason; the
     * delete refuses as a server fault without it, rather than removing a rung unchecked.
     */
    @Optional() private readonly references?: OrgLevelReferenceSearch,
  ) {}

  /**
   * The active ladder the caller's own office stands on.
   *
   * Here rather than in each consumer because two now need it — `TenantConfigService`
   * serves it to every member's badge (P4-T9) and `RatioService` validates applicability
   * against it (P4-T15) — and "find the office, read its company, list that company's
   * rungs" derived twice is two chances to disagree about which rungs an office has.
   *
   * Empty for a caller in no office. That is a valid state, not an error: a person who has
   * registered and not yet joined has no ladder, and every consumer renders that as
   * "no constraint" rather than as a failure.
   */
  /**
   * Normalise a list of rung codes, refusing any the caller's company does not have.
   *
   * Here rather than in each consumer for the same reason `ladderForOffice` is — two
   * copies would be two answers to which rungs an office has, and they would drift in the
   * message before they drifted in the rule.
   *
   * **Empty means every rung**, so it short-circuits without reading the ladder at all:
   * an office that never opens the control never pays for it, and a caller cannot
   * accidentally narrow something to nothing by sending `[]`.
   *
   * **Archived rungs are refused.** An archived rung is still readable, so a naive
   * "does it exist" check passes and the thing bound to it silently applies to nobody.
   *
   * `subject` names what is being scoped, because the same refusal has to read sensibly
   * for a ratio and for an activity category.
   */
  async checkedRungs(ctx: RequestContext, codes: string[], subject: 'ratio' | 'section'): Promise<string[]> {
    if (codes.length === 0) return [];
    const normalised = [...new Set(codes.map((c) => c.trim().toUpperCase()))];
    const ladder = await this.ladderForOffice(ctx);
    const active = new Set(ladder.filter((l) => l.status === 'active').map((l) => l.code));
    const unknown = normalised.filter((c) => !active.has(c));
    if (unknown.length) {
      throw new DomainException(
        ErrorCode.CONFIG_RUNG_UNKNOWN,
        TENANTS_REFUSALS.CONFIG_RUNG_UNKNOWN.notOnTheLadder({ codes: unknown, subject }),
        HttpStatus.BAD_REQUEST,
      );
    }
    return normalised;
  }

  async ladderForOffice(ctx: RequestContext): Promise<OrgLevelRow[]> {
    const kpmId = ctx.kpmId;
    if (!kpmId) return [];
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec();
    if (!kpm) return [];
    return this.list(ctx, kpm.companyId);
  }

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        TENANTS_REFUSALS.PERM_DENIED.noPermissionForThat,
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
      // As stored, or — for a row written before the field — as migration 0030 writes it.
      leaderTier: tierOfRung(level),
      status: level.status,
      archivedAt: level.archivedAt ? level.archivedAt.toISOString() : null,
      version: level.version ?? 0,
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

  /**
   * One company's active rung codes, junior first.
   *
   * Unpermissioned on purpose: this is not a read of anybody's data, it is the shape of
   * the company's own vocabulary, and `HierarchyService` needs it to seed a counts object
   * that has an entry per rung rather than only per rung somebody happens to stand on.
   */
  async activeCodesFor(companyId: string): Promise<string[]> {
    const rows = await this.levels
      .find({ companyId, status: 'active', deletedAt: null })
      .sort({ displayOrder: 1 })
      .exec();
    return rows.map((r) => r.code);
  }

  /**
   * **The class each active rung of one company gives its members, by code** (ADR-0156): `senior` → `ab`,
   * `associate` → `aab`, none → `agent`.
   *
   * Unpermissioned for the reason `activeCodesFor` is: the company's own vocabulary, read by the roster import
   * to count the leaders a file would add before any row is written, without a seat taken on a guess at the
   * code. A code that is not here is no active rung, and the write that names it is refused on its own.
   */
  async classesByCode(companyId: string): Promise<Map<string, RoleClass>> {
    const rows = await this.levels.find({ companyId, status: 'active', deletedAt: null }).exec();
    return new Map(rows.map((r) => [r.code, roleClassOf(tierOfRung(r))]));
  }

  /**
   * **The rung a placement with no choice of rung lands on** (ADR-0156): an office's Owner on the company's
   * **Senior Leader** rung — the highest by display order, should there be several — and anybody joining by request,
   * invite or leader code on its lowest rung that leads nobody. The default ladder answers `AB` and `AGENT`, as the
   * placements always wrote; a custom ladder answers its own codes, where naming `AB` or `AGENT` would find no rung.
   * A ladder with no such rung refuses `409 ORG_LEVEL_NOT_ON_LADDER`, naming what is missing.
   */
  async entryRungCode(companyId: string, purpose: 'owner' | 'joiner'): Promise<string> {
    const rows = await this.levels
      .find({ companyId, status: 'active', deletedAt: null })
      .sort({ displayOrder: purpose === 'owner' ? -1 : 1 })
      .exec();
    const wanted = purpose === 'owner' ? 'senior' : null;
    const rung = rows.find((r) => tierOfRung(r) === wanted);
    if (!rung) {
      throw new DomainException(
        ErrorCode.ORG_LEVEL_NOT_ON_LADDER,
        purpose === 'owner'
          ? TENANTS_REFUSALS.ORG_LEVEL_NOT_ON_LADDER.noOwnerRung
          : TENANTS_REFUSALS.ORG_LEVEL_NOT_ON_LADDER.noJoinerRung,
        HttpStatus.CONFLICT,
        { companyId, purpose },
      );
    }
    return rung.code;
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
    for (const { code, label, displayOrder, leaderTier } of DEFAULT_ORG_LADDER) {
      const existing = await this.levels.findOne({ companyId, code, deletedAt: null }).exec();
      if (existing) continue;
      await this.levels.create({
        companyId, code, label, displayOrder, leaderTier,
        status: 'active', archivedAt: null, deletedAt: null,
      });
    }
  }

  /**
   * **A new company's ladder, copied from another company's** (ADR-0164 §4): the Template library's active
   * rungs, each with its code, label, order and leader tier, written as the new company's own. A copy, never a
   * link: a later change to either ladder is that company's alone.
   *
   * A source with no active rung gives the default ladder instead, because a company without a ladder is one
   * nobody can join (ADR-0012 §3). No permission check and no audit row, for `seedDefaultLadder`'s reason: it is
   * part of creating the company, which is audited as one event. Idempotent, a rung already there kept.
   */
  async copyLadderFrom(sourceCompanyId: string, companyId: string): Promise<number> {
    const source = await this.levels
      .find({ companyId: sourceCompanyId, status: 'active', deletedAt: null })
      .sort({ displayOrder: 1 })
      .exec();
    if (source.length === 0) {
      await this.seedDefaultLadder(companyId);
      return 0;
    }
    let copied = 0;
    for (const rung of source) {
      if (await this.levels.exists({ companyId, code: rung.code, deletedAt: null }).exec()) continue;
      await this.levels.create({
        companyId, code: rung.code, label: rung.label, displayOrder: rung.displayOrder,
        // Written explicitly: a source rung that predates the field reads its tier as migration 0030 gives it.
        leaderTier: tierOfRung(rung),
        status: 'active', archivedAt: null, deletedAt: null,
      });
      copied += 1;
    }
    return copied;
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
        TENANTS_REFUSALS.ORG_LEVEL_NOT_ON_LADDER.noLevel({ code: code.toUpperCase() }),
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
    // would change what every membership pointing at the old one means. A **deleted** one does
    // not (ADR-0213 §2): it was deleted because nothing named it, so nothing can come to mean the
    // new rung — and the unique index leaves deleted rows out too.
    const clash = await this.levels
      .findOne({ companyId: input.companyId, code, deletedAt: null })
      .exec();
    if (clash) {
      throw new DomainException(
        ErrorCode.ORG_LEVEL_CODE_TAKEN,
        TENANTS_REFUSALS.ORG_LEVEL_CODE_TAKEN.taken({ company: company.name, code, archived: clash.status === 'archived' }),
        HttpStatus.CONFLICT,
        { companyId: input.companyId, code, status: clash.status },
      );
    }

    const level = await this.levels.create({
      companyId: input.companyId,
      code,
      label: input.label.trim(),
      displayOrder: input.displayOrder,
      // Stored explicitly, `null` included: an absent tier reads as the default ladder's (`tierOfRung`), and a
      // new rung coded `AB` that the Super Admin did not mark is *Not a leader*, not a guess from its code.
      leaderTier: input.leaderTier ?? null,
      status: 'active',
      archivedAt: null,
      deletedAt: null,
    });

    await this.audit.record(ctx, {
      action: 'org_level.created',
      targetCollection: 'companyOrgLevels',
      targetId: String(level._id),
      after: {
        companyId: level.companyId, code: level.code, label: level.label, displayOrder: level.displayOrder,
        leaderTier: level.leaderTier ?? null,
      },
    });

    return this.list(ctx, input.companyId);
  }

  /**
   * Rename, reorder, archive, or set the leader tier.
   *
   * **The code is not updatable, at all.** It is the identity every membership and every
   * history row holds, and invariant 3 says it never changes once published. Renaming is
   * what `label` is for; a genuinely different rung is a new level.
   *
   * **The tier is refused while anybody holds the rung** (ADR-0156 §5): `409 ORG_LEVEL_TIER_IN_USE` with the
   * count, before anything is written. Each member's class was derived from the tier when they were placed, so a
   * change would leave them holding rights their rung no longer gives — or re-class all of them at once, which
   * nobody asked for. Move them first, or add a new rung. Setting the tier it already has is no change.
   *
   * **Pinned to the version read, when one is sent** (P19-T6 AC-2; the 11-03 handover's B1-10): an `expectedVersion`
   * the rung has moved past is refused `409 VERSION_CONFLICT`, before anything else is asked and with nothing
   * written. Every write moves the version, and the write is conditional on the version it started from, so of two
   * writes racing on one rung exactly one lands; the other is the same `409`.
   */
  async update(
    ctx: RequestContext,
    orgLevelId: string,
    input: UpdateOrgLevelInput,
  ): Promise<OrgLevelRow[]> {
    this.require(ctx, 'org_level:crud');

    const level = await this.levels
      .findOne({ _id: orgLevelId, deletedAt: null })
      .exec()
      // A malformed id is "not here", not a 500: these arrive from a URL, and an
      // uncaught CastError renders as INTERNAL_ERROR and is logged as unhandled.
      .catch(() => null);
    if (!level) throw new NotFoundException('Org level');

    const version = level.version ?? 0;
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      throw new VersionConflictException(input.expectedVersion, version);
    }

    const tier = tierOfRung(level);
    const before = { label: level.label, displayOrder: level.displayOrder, leaderTier: tier, status: level.status };
    const set: Partial<CompanyOrgLevel> = { version: version + 1 };

    if (input.leaderTier !== undefined && input.leaderTier !== tier) {
      const members = await this.requireHolders().countHoldingRungAcrossTenants(ctx, String(level._id));
      if (members > 0) {
        throw new DomainException(
          ErrorCode.ORG_LEVEL_TIER_IN_USE,
          TENANTS_REFUSALS.ORG_LEVEL_TIER_IN_USE.held({ members, label: level.label }),
          HttpStatus.CONFLICT,
          { orgLevelId: String(level._id), code: level.code, members },
        );
      }
      set.leaderTier = input.leaderTier;
    }
    if (input.label !== undefined) set.label = input.label.trim();
    if (input.displayOrder !== undefined) set.displayOrder = input.displayOrder;
    if (input.status !== undefined && input.status !== level.status) {
      set.status = input.status;
      // Archiving stamps the date; un-archiving clears it, so the field always answers
      // "when did this stop being offered" rather than "when was it last touched".
      set.archivedAt = input.status === 'archived' ? this.clock.now() : null;
    }

    // Only the fields that change, as `save()` wrote them: a row with no stored tier keeps reading it from its code.
    const written = await this.levels.findOneAndUpdate(
      { _id: level._id, deletedAt: null, ...atVersion(version) },
      { $set: set },
      { new: true },
    ).exec();
    if (!written) {
      const now = await this.levels.findOne({ _id: level._id, deletedAt: null }).exec();
      if (!now) throw new NotFoundException('Org level');
      throw new VersionConflictException(input.expectedVersion ?? version, now.version ?? 0);
    }

    await this.audit.record(ctx, {
      action: input.status === 'archived' ? 'org_level.archived' : 'org_level.updated',
      targetCollection: 'companyOrgLevels',
      targetId: String(written._id),
      before,
      after: {
        label: written.label, displayOrder: written.displayOrder, leaderTier: tierOfRung(written), status: written.status,
      },
    });

    return this.list(ctx, written.companyId);
  }

  /**
   * **Delete an archived rung that nothing names** (B1-6; ADR-0213 §2; P19.4-T5 AC-2): a soft delete — `deletedAt` —
   * audited as `org_level.deleted` with its code and label (invariant §6), and the company's ladder answered as it now
   * stands.
   *
   * - **Only an archived rung.** A live one is refused `409 ORG_LEVEL_IN_USE` with no references: it is archived first.
   * - **Only when nothing in its company names it** (`OrgLevelReferenceSearch`): a membership of any status or its role
   *   history, a leader-limit request, an office's live or published setting, a campaign, the company's carrier rules,
   *   any version or draft of its templates. Otherwise `409 ORG_LEVEL_IN_USE`, `details.references` naming each kind
   *   and how many, and the sentence saying why.
   * - **Pinned to the version read, when one is sent** (`expectedVersion`), as every write of a rung is (P19-T6).
   * - **Its code may be used again afterwards**: nothing named it, so nothing can come to mean the new rung.
   *
   * The Template library's ladder follows the same rule. `org_level:crud`, the Super Admin's.
   */
  async remove(ctx: RequestContext, orgLevelId: string, expectedVersion?: number): Promise<OrgLevelRow[]> {
    this.require(ctx, 'org_level:crud');
    const level = await this.levels.findOne({ _id: orgLevelId, deletedAt: null }).exec().catch(() => null);
    if (!level) throw new NotFoundException('Org level');

    const version = level.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== version) {
      throw new VersionConflictException(expectedVersion, version);
    }
    if (level.status !== 'archived') throw this.inUse(level, [], 'active');

    const references = await this.requireReferences().of(ctx, {
      orgLevelId: String(level._id), companyId: level.companyId, code: level.code,
    });
    if (references.length > 0) throw this.inUse(level, references, 'named');

    const at = this.clock.now();
    const deleted = await this.levels.findOneAndUpdate(
      { _id: level._id, status: 'archived', deletedAt: null, ...atVersion(version) },
      { $set: { deletedAt: at, version: version + 1 } },
      { new: true },
    ).exec();
    if (!deleted) {
      // Restored, changed or deleted between the read and the write: say what it is now.
      const now = await this.levels.findOne({ _id: level._id, deletedAt: null }).exec();
      if (!now) throw new NotFoundException('Org level');
      throw new VersionConflictException(expectedVersion ?? version, now.version ?? 0);
    }

    await this.audit.record(ctx, {
      action: 'org_level.deleted',
      targetCollection: 'companyOrgLevels',
      targetId: String(level._id),
      before: { companyId: level.companyId, code: level.code, label: level.label, status: level.status },
      after: { companyId: level.companyId, code: level.code, label: level.label, deletedAt: at.toISOString() },
    });
    return this.list(ctx, level.companyId);
  }

  /** `409 ORG_LEVEL_IN_USE`: live, or named by the records listed. */
  private inUse(
    level: CompanyOrgLevelDocument, references: OrgLevelReference[], why: 'active' | 'named',
  ): DomainException {
    return new DomainException(
      ErrorCode.ORG_LEVEL_IN_USE,
      why === 'active'
        ? TENANTS_REFUSALS.ORG_LEVEL_IN_USE.stillActive({ label: level.label })
        : TENANTS_REFUSALS.ORG_LEVEL_IN_USE.named({ label: level.label, references }),
      HttpStatus.CONFLICT,
      { orgLevelId: String(level._id), code: level.code, status: level.status, references },
    );
  }

  /** The reference search, or a server fault: never a rung deleted without asking what names it. */
  private requireReferences(): OrgLevelReferenceSearch {
    if (!this.references) {
      throw new DomainException(
        ErrorCode.INTERNAL_ERROR,
        TENANTS_REFUSALS.INTERNAL_ERROR.ladderCannotSearch,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return this.references;
  }

  /** The membership repository, or a server fault: never a tier changed without asking who holds the rung. */
  private requireHolders(): MembershipRepository {
    if (!this.members) {
      throw new DomainException(
        ErrorCode.INTERNAL_ERROR,
        TENANTS_REFUSALS.INTERNAL_ERROR.ladderCannotCount,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return this.members;
  }
}
