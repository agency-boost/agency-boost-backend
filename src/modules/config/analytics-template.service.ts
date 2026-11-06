import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  ANALYTICS, ANALYTICS_FIELD_READERS, DEFAULT_TENANT_TIMEZONE, DEMOGRAPHICS, QUANT, type FieldReader,
} from '@/domain/constants';
import { addMonths } from '@/domain/metrics/campaign-window';
import { can } from '@/modules/rbac/permissions';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import {
  agentCodePattern, analyticsViolations, codeCheck, KODE_OF_CELL, newColumns, normaliseAnalyticsDraft,
  platformAnalyticsConfig, refuseAnalyticsViolations, uploadChanged, type AdvancedAnalyticsConfig,
} from './analytics-config';
import { AnalyticsConfigReader } from './analytics-config.reader';
import { ANALYTICS_TEMPLATE_REFUSALS } from './analytics-template.messages';
import { CompanyTemplate, CompanyTemplateDocument } from './company-template.schema';
import { NamedTemplateService } from './named-template.service';
import { OpenSurveyRuns, type OpenRunCounts } from './open-survey-runs.port';

/**
 * **What the section's editor reads beside the payload** (P19.5-T1; ADR-0214 §1, §2, §6): carried on every answer of
 * the kind routes for `advanced_analytics`, as the playbook's editor view is for its kind.
 */
export interface AnalyticsEditorView {
  /** How many live KPMs read the template now: the publish dialog's *"berlaku untuk semua KPM … (N KPM)"*. */
  kpms: number;
  /**
   * **The kodes a KPM on the template holds a value for, each with the earliest month it does** (AA UI-017): their
   * *Satuan* is locked and their *Berlaku mulai* read-only, and the API refuses a change of either.
   */
  held: Record<string, string>;
  /** The month after this one, in the platform's zone (ADR-0016): a new column's *Berlaku mulai* by default (R2). */
  nextMonth: string;
  /** *Dipakai di*: every reader of each kode, in both languages (`ANALYTICS_FIELD_READERS`). */
  readers: Readonly<Record<string, readonly FieldReader[]>>;
  /** The bounds a draft is held to, served so the editor never re-declares one (invariant §7). */
  limits: {
    uploadFieldsMax: number;
    codePatternMaxLength: number;
    completePctMin: number;
    completePctMax: number;
    ytdTolerancePctMax: number;
    historyMonthsBeforeJoin: number;
    minPeers: number;
    ageLabelFloor: number;
    labelMaxLength: number;
    tipMaxLength: number;
    questionMaxLength: number;
    peerBandPctMax: number;
  };
}

/** The legacy month cells, each as the kode version 1 gives it — until P19.5-T2 stores the row by kode. */
const LEGACY_CELLS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(KODE_OF_CELL)
    .filter(([cell]) => cell !== 'unitPersistency')
    .flatMap(([cell, kode]) => [[`${cell}Monthly`, kode], [`${cell}Ytd`, kode]])),
  unitPersistencyMonthly: 'UNIT_PERSISTENCY',
};

/**
 * **The template's *Advanced analytics* section, on the Super Admin's side** (P19.5-T1; ADR-0214 §1, §2, §4, §7).
 *
 * `TemplateService` drafts and publishes the kind as it does every other; this is what is particular to this one —
 *
 * - the editor's view (`editorOf`): the KPMs on the template, the kodes they hold data for, *Dipakai di*, the bounds;
 * - the draft's rules (`checkDraft`): the payload's type, then the system columns, the locks, the aliases and the
 *   archive, against the version the KPMs read now;
 * - the publish's (`checkPublish`): the type again, and **the agent-code pattern over every registered code** of every
 *   KPM on the template — any mismatch refuses the publish whole;
 * - after a publish (`announce`): one in-app notice to each Owner and each Admin of every KPM on the template;
 * - the two reads the editor makes as it is used: `codeCheck` and `openRuns`.
 *
 * Every cross-KPM read is a named unscoped method, refused to anybody but a Super Admin (invariant §1). Nothing here
 * writes a KPM's data: the section is read live (ADR-0214 §3), never copied.
 */
@Injectable()
export class AnalyticsTemplateService {
  constructor(
    @InjectModel(CompanyTemplate.name) private readonly sections: Model<CompanyTemplateDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly reader: AnalyticsConfigReader,
    private readonly named: NamedTemplateService,
    private readonly memberships: MembershipRepository,
    private readonly monthRows: MonthlyAgentDataRepository,
    private readonly notifications: NotificationService,
    private readonly surveys: OpenSurveyRuns,
    private readonly clock: Clock,
  ) {}

  /** The editor's view of one template's section. */
  async editorOf(ctx: RequestContext, companyId: string, templateId: string): Promise<AnalyticsEditorView> {
    const offices = await this.reader.officesReading(companyId, templateId);
    const held = await this.held(ctx, offices);
    const thisMonth = this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(0, 7);
    return {
      kpms: offices.length,
      held: Object.fromEntries(held),
      nextMonth: addMonths(thisMonth, 1),
      readers: ANALYTICS_FIELD_READERS,
      limits: {
        uploadFieldsMax: ANALYTICS.UPLOAD_FIELDS_MAX,
        codePatternMaxLength: ANALYTICS.CODE_PATTERN_MAX_LENGTH,
        completePctMin: ANALYTICS.COMPLETE_PCT_MIN,
        completePctMax: ANALYTICS.COMPLETE_PCT_MAX,
        ytdTolerancePctMax: ANALYTICS.YTD_TOLERANCE_PCT_MAX,
        historyMonthsBeforeJoin: ANALYTICS.HISTORY_MONTHS_BEFORE_JOIN,
        minPeers: QUANT.MIN_PEERS,
        ageLabelFloor: DEMOGRAPHICS.AGE_LABEL_FLOOR,
        labelMaxLength: ANALYTICS.LABEL_MAX_LENGTH,
        tipMaxLength: ANALYTICS.TIP_MAX_LENGTH,
        questionMaxLength: ANALYTICS.QUESTION_MAX_LENGTH,
        peerBandPctMax: QUANT.PEER_BAND_PCT_MAX,
      },
    };
  }

  /**
   * **A draft, checked and kept** (ADR-0214 §2): `400 VALIDATION_FAILED` for anything that breaks the type, each
   * violation beside its field; then the `409`s and the kept rules of `normaliseAnalyticsDraft`, against the version
   * the KPMs read now — the newest published, else the platform's. Answers the payload to store.
   */
  async checkDraft(
    ctx: RequestContext, companyId: string, templateId: string, payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    refuseAnalyticsViolations(analyticsViolations(payload));
    const previous = (await this.published(companyId, templateId))?.payload ?? platformAnalyticsConfig();
    const offices = await this.reader.officesReading(companyId, templateId);
    const held = await this.held(ctx, offices);
    return normaliseAnalyticsDraft(payload as unknown as AdvancedAnalyticsConfig, previous, new Set(held.keys())) as unknown as
      Record<string, unknown>;
  }

  /**
   * **Before a publish** (ADR-0214 §7; AA UI-018, AT-10, Case 10): the payload whole, and the agent-code pattern over
   * every registered code of every KPM on the template. A mismatch is `409 ANALYTICS_CODE_PATTERN_MISMATCH`, `details:
   * { mismatched, total, examples }`, and nothing is published.
   */
  async checkPublish(ctx: RequestContext, companyId: string, templateId: string, payload: Record<string, unknown>): Promise<void> {
    refuseAnalyticsViolations(analyticsViolations(payload));
    const config = payload as unknown as AdvancedAnalyticsConfig;
    const compiled = agentCodePattern(config.uploadRules.agentCodePattern);
    // Already refused by the check above when it cannot compile.
    if (!('pattern' in compiled)) return;
    const offices = await this.reader.officesReading(companyId, templateId);
    const result = codeCheck(compiled.pattern, await this.memberships.agentCodesInOfficesAcrossTenants(ctx, offices));
    if (result.mismatched > 0) {
      throw new DomainException(
        ErrorCode.ANALYTICS_CODE_PATTERN_MISMATCH,
        ANALYTICS_TEMPLATE_REFUSALS.ANALYTICS_CODE_PATTERN_MISMATCH.mismatch(result),
        HttpStatus.CONFLICT,
        { ...result, pattern: config.uploadRules.agentCodePattern },
      );
    }
  }

  /**
   * **After a publish: the Owners and the Admins told** (ADR-0214 §4; AA UI-019, AT-1). Only when the columns, the
   * archive or the upload rules changed against `previous`. Each KPM on the template: its Owner and each active Admin,
   * **once per person per publish** — someone who is both is told once. In-app only. Answers how many were told.
   */
  async announce(
    ctx: RequestContext,
    template: { companyId: string; id: string; name: string },
    previous: AdvancedAnalyticsConfig | null,
    published: AdvancedAnalyticsConfig,
    version: number,
  ): Promise<number> {
    if (!uploadChanged(previous ?? platformAnalyticsConfig(), published)) return 0;
    const added = newColumns(previous ?? platformAnalyticsConfig(), published)
      .map((f) => ({ kode: f.kode, label: f.label, effectiveFrom: f.effectiveFrom }));
    let told = 0;
    for (const kpmId of await this.reader.officesReading(template.companyId, template.id)) {
      const kctx = RequestContext.superAdminInTenant(ctx.userId, kpmId);
      const kpm = await this.kpms.findOne({ _id: kpmId, deletedAt: null }, { ownerUserId: 1 }).lean().exec() as
        { ownerUserId?: string | null } | null;
      const admins = await this.memberships.find(kctx, { status: 'active', 'adminAccess.isKpmAdmin': true });
      const people = new Set([...(kpm?.ownerUserId ? [kpm.ownerUserId] : []), ...admins.map((m) => String(m.userId))]);
      for (const userId of people) {
        await this.notifications.send({
          userId,
          kpmId,
          templateId: NotificationTemplate.ANALYTICS_TEMPLATE_PUBLISHED,
          payload: { templateId: template.id, templateName: template.name, version, newColumns: added },
        });
        told += 1;
      }
    }
    return told;
  }

  /**
   * **`GET …/template/advanced_analytics/code-check`** (ADR-0214 §1, §7): how many registered codes of the template's
   * KPMs a pattern does not match, and up to five examples — the field's live *"<n> dari <total> kode terdaftar tidak
   * cocok (mis. …)"*. `400` for a pattern the engine refuses; `404` for a template that is not the company's.
   */
  async codeCheck(
    ctx: RequestContext, companyId: string, templateId: string | undefined, pattern: string, example?: string,
  ): Promise<{ mismatched: number; total: number; examples: string[]; exampleMatches?: boolean }> {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
    const template = await this.named.resolve(companyId, templateId);
    const compiled = agentCodePattern(pattern);
    if ('refusal' in compiled) {
      throw new InvalidRequestException(compiled.refusal, { violations: [{ field: 'pattern', message: compiled.refusal }] });
    }
    const offices = await this.reader.officesReading(companyId, String(template._id));
    const result = codeCheck(compiled.pattern, await this.memberships.agentCodesInOfficesAcrossTenants(ctx, offices));
    return example === undefined ? result : { ...result, exampleMatches: compiled.pattern.test(example) };
  }

  /**
   * **`GET …/template/advanced_analytics/open-runs`** (ADR-0214 §1; ADR-0216 §2): how many NPS and qualitative runs are
   * open in the template's KPMs, and in how many — counts only, for the *Bagian* switch's question.
   */
  async openRuns(
    ctx: RequestContext, companyId: string, templateId: string | undefined,
  ): Promise<{ nps: OpenRunCounts; qual: OpenRunCounts }> {
    if (!can(ctx, 'company_template:read')) throw new PermissionDeniedException('company_template:read');
    const template = await this.named.resolve(companyId, templateId);
    const offices = await this.reader.officesReading(companyId, String(template._id));
    const [nps, qual] = await Promise.all([this.surveys.openIn(ctx, offices, 'nps'), this.surveys.openIn(ctx, offices, 'qual')]);
    return { nps, qual };
  }

  /** The template's newest published section, or `null`. */
  async published(companyId: string, templateId: string): Promise<{ version: number; payload: AdvancedAnalyticsConfig } | null> {
    const row = await this.sections
      .findOne({ companyId, templateId, kind: 'advanced_analytics', status: 'published', deletedAt: null })
      .sort({ version: -1 })
      .lean().exec();
    return row ? { version: row.version, payload: row.payload as unknown as AdvancedAnalyticsConfig } : null;
  }

  /** The kodes the offices hold a value for, each with its earliest month. */
  private async held(ctx: RequestContext, offices: readonly string[]): Promise<Map<string, string>> {
    return this.monthRows.kodesHeldInOfficesAcrossTenants(ctx, offices, LEGACY_CELLS);
  }
}
