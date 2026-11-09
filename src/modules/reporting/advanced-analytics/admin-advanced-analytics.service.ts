import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ANALYTICS_SECTION_SLUGS, PLATFORM_READ } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { can } from '@/modules/rbac/permissions';
import { SurveyRunsService } from '@/modules/surveys/survey-runs.service';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { AdvancedAnalyticsService } from './advanced-analytics.service';

/** What the Super Admin's tab reads: the shell, or a section by its slug. */
export const ADMIN_SECTIONS = ['shell', ...Object.values(ANALYTICS_SECTION_SLUGS)] as const;

export interface AdminSectionQuery {
  month?: string;
  ab?: string;
  year?: string;
  periodEnd?: string;
  runId?: string;
}

/**
 * **The Super Admin's *Advanced analytics* tab on a KPM — *Lihat sebagai KPM*, read-only** (P19.5-T3 AC-12; ADR-0215 §9;
 * ADR-0207 §4, §5; SA UI-013). Under `platform_kpm_figures:read` alone; the Super Admin holds no
 * `advanced_analytics:read` (roles §3.9).
 *
 * - **What the KPM's Owner sees**, through the KPM's own functions over a platform read's context
 *   (`advancedAnalyticsForOffice`, `SurveyRunsService.results`): nothing is computed a second way, and nothing in the
 *   KPM is written — not a target, not a run's freeze, not a survey's opening.
 * - **The surveys as summaries** (A-R9; ADR-0216 §3): the `summary` audience — counts, scores and percentages, no free
 *   text and no *Dukungan leader*.
 * - **Audited per visit** as `platform_read.kpm_advanced_analytics`: one entry in the platform's log and one in the
 *   KPM's, with the fixed purpose, the section and its filters, written after the answer is computed and before it is
 *   sent; **a failure fails the read**.
 */
@Injectable()
export class AdminAdvancedAnalytics {
  constructor(
    /** The office's own row, by id: whether it is live. No figure is read from it. */
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly analytics: AdvancedAnalyticsService,
    private readonly surveys: SurveyRunsService,
    private readonly audit: AuditService,
  ) {}

  async read(ctx: RequestContext, kpmId: string, section: string, query: AdminSectionQuery): Promise<unknown> {
    // The route's own guard has asked; this is the second wall (ADR-0207 §1): a Super Admin, outside any session.
    if (!ctx.isSuperAdmin || ctx.isImpersonating || !can(ctx, 'platform_kpm_figures:read')) {
      throw new PermissionDeniedException('platform_kpm_figures:read');
    }
    const kpm = isValidObjectId(kpmId) ? await this.kpms.findOne({ _id: kpmId, deletedAt: null }, { _id: 1 }).lean().exec() : null;
    if (!kpm) throw new NotFoundException('KPM');
    if (!(ADMIN_SECTIONS as readonly string[]).includes(section)) throw new NotFoundException('Advanced analytics');
    const office = RequestContext.platformRead(ctx, kpmId);
    const view = section === 'nps' || section === 'qual'
      ? await this.surveys.results(office, section, query.runId)
      : await this.analytics.advancedAnalyticsForOffice(office, section, query);
    const filters = Object.fromEntries(Object.entries({ section, ...query }).filter(([, v]) => v !== undefined));
    await this.audit.recordInScopesOrFail(ctx, [
      {
        kpmId: null,
        entry: {
          action: PLATFORM_READ.ACTION.kpmAdvancedAnalytics, targetCollection: 'kpms', targetId: kpmId,
          after: { purpose: PLATFORM_READ.PURPOSE.figures, filters: { tab: 'advanced', ...filters }, page: null, rows: 1, kpmIds: [kpmId] },
        },
      },
      {
        kpmId,
        entry: {
          action: PLATFORM_READ.ACTION.kpmAdvancedAnalytics, targetCollection: 'kpms', targetId: kpmId,
          after: { purpose: PLATFORM_READ.PURPOSE.figures, rows: 1, tab: 'advanced', ...filters },
        },
      },
    ]);
    return view;
  }
}
