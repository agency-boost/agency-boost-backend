import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { joinSentences } from '@/common/i18n/sentence';
import { ErrorCode } from '@/common/errors/error-codes';
import { AuditService } from '@/modules/audit/audit.service';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { ActivityBindingRepository, ActivityTypeRepository } from './activity.repository';
import type { ActivityBindingDocument } from './activity-binding.schema';
import { CONFIG_REFUSALS } from './config.messages';
import {
  BINDING_ROLES, bindingProblems, defaultBinding, normalisedBinding, type CascadeBinding,
} from './activity-binding';

/** The binding as a reader is given it: the three lists, and the version a write must name. */
export interface ActivityBindingView extends CascadeBinding {
  /** 0 for an office with no binding row yet — it counts the default binding. */
  version: number;
  updatedAt: string | null;
}

/** One of the office's activity types, as the Super Admin's binding card offers it. */
export interface BindableType {
  code: string;
  label: string;
  categoryCode: string;
  displayOrder: number;
  status: 'active' | 'archived';
}

/** `GET`/`PUT /admin/tenants/:kpmId/activity-binding`: the binding, and every type it may name. */
export interface OfficeActivityBindingView extends ActivityBindingView {
  kpmId: string;
  /** Every activity type the office holds, archived ones included (their history counts), in its order. */
  types: BindableType[];
}

function viewOf(row: ActivityBindingDocument | null): ActivityBindingView {
  if (!row) return { ...defaultBinding(), version: 0, updatedAt: null };
  return {
    leads: [...row.leads],
    appointments: [...row.appointments],
    closings: [...row.closings],
    version: row.version,
    updatedAt: (row as unknown as { updatedAt?: Date }).updatedAt?.toISOString() ?? null,
  };
}

/**
 * **The office's activity binding** (ADR-0163): which activity types each cascade role counts, and the one
 * place every count asks.
 *
 * - **`resolveCascadeBinding(ctx)` is the only reader** for counting (AC-2): the summary's targets and pace,
 *   coaching's activity summary, the Unit Dashboard, pace status, the measured rates, the goal screen's
 *   chips and the campaigns' cascade touches. A role bound to `[A, B]` counts both. It reads the office's
 *   **live** binding — the Super Admin keeps it, the Owner does not publish it, so a rebind counts from the
 *   moment it is saved, as the Summary's sections already read the live taxonomy (`sectionsShown`).
 * - **The Super Admin edits it per office** through the named cross-tenant read (`findInOfficeAcrossTenants`,
 *   registered in `named-cross-tenant-reads.tenancy.spec.ts`) and a write scoped to that office alone
 *   (`RequestContext.superAdminInTenant`, as the roster import writes). Nothing outside configuration is read.
 * - **The Owner and the Admin read it** for their own office.
 */
@Injectable()
export class ActivityBindingService {
  constructor(
    private readonly bindings: ActivityBindingRepository,
    private readonly types: ActivityTypeRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly audit: AuditService,
  ) {}

  /**
   * **The one resolver** (ADR-0163 §4): the office's binding, or the default binding for an office that has
   * no row — one provisioned before the binding existed and not yet migrated, which counted the platform's
   * three codes all along.
   */
  async resolveCascadeBinding(ctx: RequestContext): Promise<CascadeBinding> {
    const { leads, appointments, closings } = viewOf(await this.live(ctx));
    return { leads, appointments, closings };
  }

  /** `GET /kpm/settings/activity-binding`: the Owner's and the Admin's read of their own office's. */
  async readOwn(ctx: RequestContext): Promise<ActivityBindingView> {
    return viewOf(await this.live(ctx));
  }

  /**
   * `GET /admin/tenants/:kpmId/activity-binding`: one named office's binding and its types.
   *
   * The Super Admin's, through the named cross-tenant read. An Owner or an Admin holds `activity_binding:read` at
   * `own-kpm`, so the route serves their own office through the scoped repository — and another office is `404`,
   * the answer an office that does not exist gets, never `403` (ADR-0002).
   */
  async readForOffice(ctx: RequestContext, kpmId: string): Promise<OfficeActivityBindingView> {
    await this.office(ctx, kpmId);
    const [[row], types] = await Promise.all(ctx.isSuperAdmin
      ? [
        this.bindings.findInOfficeAcrossTenants(ctx, kpmId, { status: 'active' }, { limit: 1 }),
        this.types.findInOfficeAcrossTenants(ctx, kpmId, {}, { sort: { displayOrder: 1 } }),
      ]
      : [
        this.bindings.find(ctx, { status: 'active' }, { limit: 1 }),
        this.types.find(ctx, {}, { sort: { displayOrder: 1 } }),
      ]);
    return {
      kpmId,
      ...viewOf(row ?? null),
      types: types.map((t) => ({
        code: t.code, label: t.label, categoryCode: t.categoryCode, displayOrder: t.displayOrder, status: t.status,
      })),
    };
  }

  /**
   * `PUT /admin/tenants/:kpmId/activity-binding` (ADR-0163 §3): the whole binding, every time.
   *
   * Every code must be one of **that office's** activity types — archived allowed, since its history still counts,
   * unknown refused `400`. A role holds at least one code, and a code sits in one role. `expectedVersion`, when sent,
   * must be the version read, or `409 VERSION_CONFLICT`. Written in that office alone, version bumped, and audited
   * `activity_binding.updated` with the binding before and after.
   */
  async updateForOffice(
    ctx: RequestContext, kpmId: string, body: Record<string, unknown>,
  ): Promise<OfficeActivityBindingView> {
    await this.office(ctx, kpmId);
    const types = await this.types.findInOfficeAcrossTenants(ctx, kpmId, {});
    const known = new Set(types.map((t) => t.code));
    const input: Record<string, unknown> = Object.fromEntries(BINDING_ROLES.map((role) => [role, body[role]]));
    // Codes are stored upper-case; a lower-case one typed by hand is the same code.
    for (const role of BINDING_ROLES) {
      const codes = input[role];
      if (Array.isArray(codes)) input[role] = codes.map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : c));
    }
    const problems = bindingProblems(input, known);
    if (problems.length) throw new InvalidRequestException(joinSentences(problems, ' '));
    const next = normalisedBinding(input);

    const [current] = await this.bindings.findInOfficeAcrossTenants(ctx, kpmId, { status: 'active' }, { limit: 1 });
    const before = viewOf(current ?? null);
    const expected = body.expectedVersion;
    if (typeof expected === 'number' && expected !== before.version) {
      throw new DomainException(
        ErrorCode.VERSION_CONFLICT,
        CONFIG_REFUSALS.VERSION_CONFLICT.bindingChanged({ version: before.version, read: expected }),
        HttpStatus.CONFLICT,
        { version: before.version },
      );
    }

    // Scoped to the one office named, and nothing else: the Super Admin is in no office of their own.
    const office = RequestContext.superAdminInTenant(ctx.userId, kpmId);
    await this.bindings.upsertOne(office, { status: 'active' }, {
      $set: { ...next },
      $setOnInsert: { status: 'active', archivedAt: null },
      $inc: { version: 1 },
    });
    await this.audit.record(office, {
      action: 'activity_binding.updated',
      targetCollection: 'activityBindings',
      targetId: kpmId,
      before: { leads: before.leads, appointments: before.appointments, closings: before.closings, version: before.version },
      after: { ...next, version: before.version + 1 },
    });
    return this.readForOffice(ctx, kpmId);
  }

  private async live(ctx: RequestContext): Promise<ActivityBindingDocument | null> {
    return this.bindings.findOne(ctx, { status: 'active' });
  }

  /**
   * The office named, or 404 — a malformed id from a URL included, and, for anybody but a Super Admin, any office
   * that is not their own: a 403 would confirm the id is real.
   */
  private async office(ctx: RequestContext, kpmId: string): Promise<KpmDocument> {
    const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }).exec().catch(() => null);
    if (!kpm || (!ctx.isSuperAdmin && ctx.kpmId !== String(kpm._id))) throw new NotFoundException('KPM');
    return kpm;
  }
}
