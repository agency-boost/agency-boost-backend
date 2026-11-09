import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NoMembershipException, NotFoundException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { LocalDate } from '@/common/time/local-day';
import type { SurveyRoleClass } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import type { AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { can } from '@/modules/rbac/permissions';
import type { SurveyKind, SurveyRunDocument } from './survey-run.schema';
import { SurveyOffice } from './survey-office';
import { SurveyOpening, sectionOn } from './survey-opening';
import { npsResults, qualResults, responsesOf, type NpsResults, type QualResults, type ResultsAudience, type ResponseRow } from './survey-results';
import { runPeriod, runState, type RunState } from './survey-rules';
import { SurveyParticipationRepository, SurveyResponseRepository, SurveyRunRepository } from './survey.repositories';
import { SURVEY_REFUSALS } from './surveys.messages';

/** A run as the KPM's NPS and *Kualitatif* tabs list it. */
export interface RunView {
  runId: string;
  kind: SurveyKind;
  periodKey: string;
  opensOn: LocalDate;
  closesOn: LocalDate;
  state: RunState;
  invitedRoleClasses: SurveyRoleClass[];
  anonymous: boolean;
  perPerson: boolean;
  remindHalfway: boolean;
  /** *n dari M*: forms sent, of the invitees (`SURVEY_RESPONSE_RATE`); `0` of `0` before it opens. */
  responses: { sent: number; invited: number; pct: number | null };
}

export interface ResultsView {
  kind: SurveyKind;
  today: LocalDate;
  /** The tab is shown: its section on in the template, or a run of it still open (AT-12, AA UI-022). */
  visible: boolean;
  sectionOn: boolean;
  /** *Mulai survei*, *Ubah* and *Batalkan*: the Owner's and the Admins', never in a view-as session. */
  canWrite: boolean;
  audience: ResultsAudience;
  /** What the start dialog fills from: the template's cadence and the run defaults (spec §2; C-R10). */
  template: {
    cadence: 'quarter' | 'half';
    qualMonths: number[];
    defaults: { anonymous: boolean; perPerson: boolean; remindHalfway: boolean };
  };
  runs: RunView[];
  selected: (RunView & { previousRunId: string | null; nps: NpsResults | null; qual: QualResults | null }) | null;
}

export interface RunInput {
  opensOn: LocalDate;
  closesOn: LocalDate;
  invitedRoleClasses: SurveyRoleClass[];
  anonymous: boolean;
  perPerson?: boolean;
  remindHalfway: boolean;
}

const MONGO_DUPLICATE_KEY = 11000;

/**
 * **A KPM's survey runs and their results** (P19.5-T4; ADR-0216 §2, §4; AC-1 to AC-4, AC-13). The Owner and the Admins
 * start a run within the template's cadence and change or cancel it until it opens; the results are read by them, by a
 * Core Leader without *Dukungan leader*, and by a view-as session as a summary.
 */
@Injectable()
export class SurveyRunsService {
  constructor(
    private readonly runs: SurveyRunRepository,
    private readonly participation: SurveyParticipationRepository,
    private readonly responses: SurveyResponseRepository,
    private readonly opening: SurveyOpening,
    private readonly office: SurveyOffice,
    private readonly config: AnalyticsConfigReader,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** **`POST /kpm/advanced-analytics/surveys/runs`** — *Mulai survei* (AC-1). */
  async create(ctx: RequestContext, kind: SurveyKind, input: RunInput): Promise<RunView> {
    requireOffice(ctx);
    const today = await this.office.today(ctx);
    const { config } = await this.config.publishedFor(ctx);
    if (!sectionOn(config, kind)) throw conflict('section_off', SURVEY_REFUSALS.SURVEY_RUN_CONFLICT.sectionOff);
    const periodKey = this.periodOf(kind, input, today, config);
    await this.refuseTaken(ctx, kind, periodKey, null);
    let created: SurveyRunDocument;
    try {
      created = await this.runs.create(ctx, { kind, periodKey, ...settings(kind, input), snapshot: null, openedAt: null, invitedCount: 0 });
    } catch (err) {
      if ((err as { code?: number }).code === MONGO_DUPLICATE_KEY) {
        throw conflict('period_taken', SURVEY_REFUSALS.SURVEY_RUN_CONFLICT.periodTaken);
      }
      throw err;
    }
    await this.audit.record(ctx, {
      action: 'survey_run.created', targetCollection: 'surveyRuns', targetId: String(created._id), after: auditable(created),
    });
    if (created.opensOn <= today) await this.opening.openDue(ctx, today);
    const fresh = (await this.runs.findById(ctx, String(created._id)))!;
    return (await this.views(ctx, [fresh], today))[0];
  }

  /** **`PATCH …/surveys/runs/:runId`** — before it opens only; afterwards `409 SURVEY_CLOSED` (`opened`). */
  async update(ctx: RequestContext, runId: string, input: Partial<RunInput>): Promise<RunView> {
    requireOffice(ctx);
    const today = await this.office.today(ctx);
    const run = await this.scheduled(ctx, runId, today);
    const next: RunInput = {
      opensOn: input.opensOn ?? run.opensOn,
      closesOn: input.closesOn ?? run.closesOn,
      invitedRoleClasses: input.invitedRoleClasses ?? run.invitedRoleClasses,
      anonymous: input.anonymous ?? run.anonymous,
      perPerson: input.perPerson ?? run.perPerson,
      remindHalfway: input.remindHalfway ?? run.remindHalfway,
    };
    const { config } = await this.config.publishedFor(ctx);
    const periodKey = this.periodOf(run.kind, next, today, config);
    await this.refuseTaken(ctx, run.kind, periodKey, runId);
    const updated = await this.runs.updateById(ctx, runId, { $set: { periodKey, ...settings(run.kind, next) } });
    await this.audit.record(ctx, {
      action: 'survey_run.updated', targetCollection: 'surveyRuns', targetId: runId,
      before: auditable(run), after: auditable(updated!),
    });
    if (updated!.opensOn <= today) await this.opening.openDue(ctx, today);
    return (await this.views(ctx, [(await this.runs.findById(ctx, runId))!], today))[0];
  }

  /** **`DELETE …/surveys/runs/:runId`** — a scheduled run cancelled: a soft delete (invariant §6). */
  async cancel(ctx: RequestContext, runId: string): Promise<void> {
    requireOffice(ctx);
    const today = await this.office.today(ctx);
    const run = await this.scheduled(ctx, runId, today);
    await this.runs.softDeleteById(ctx, runId, this.clock.now());
    await this.audit.record(ctx, {
      action: 'survey_run.cancelled', targetCollection: 'surveyRuns', targetId: runId, before: auditable(run),
    });
  }

  /**
   * **`GET /kpm/advanced-analytics/nps` · `…/qual`** — the runs, newest first, and one run's results (AC-2 to AC-4,
   * AC-13): `runId` named, else the newest that has opened. In the audience's shape (ADR-0216 §3).
   */
  async results(ctx: RequestContext, kind: SurveyKind, runId?: string): Promise<ResultsView> {
    const audience = audienceOf(ctx);
    const today = await this.office.today(ctx);
    // P19.5-T3 AC-12 (ADR-0207 §4): a Super Admin's platform read writes nothing in the KPM, a run's opening included.
    if (!ctx.isPlatformRead) await this.opening.openDue(ctx, today);
    const { config } = await this.config.publishedFor(ctx);
    const runs = await this.runs.list(ctx, kind);
    const views = await this.views(ctx, runs, today);
    const on = sectionOn(config, kind);
    const opened = runs.filter((r) => r.snapshot);
    const chosen = runId ? runs.find((r) => String(r._id) === runId) : opened[0];
    if (runId && !chosen) throw new NotFoundException('Survey run');
    let selected: ResultsView['selected'] = null;
    if (chosen) {
      const view = views.find((v) => v.runId === String(chosen._id))!;
      const previous = opened.find((r) => r.periodKey < chosen.periodKey) ?? null;
      const rows = chosen.snapshot ? await this.rows(ctx, String(chosen._id)) : [];
      selected = {
        ...view,
        previousRunId: previous ? String(previous._id) : null,
        nps: kind === 'nps' && chosen.snapshot
          ? npsResults({ snapshot: chosen.snapshot, rows, anonymous: chosen.anonymous }, audience, previous?.snapshot
            ? { snapshot: previous.snapshot, rows: await this.rows(ctx, String(previous._id)), anonymous: previous.anonymous }
            : null)
          : null,
        qual: kind === 'qual' && chosen.snapshot
          ? qualResults({ snapshot: chosen.snapshot, rows, anonymous: chosen.anonymous }, audience, config.thresholds)
          : null,
      };
    }
    return {
      kind,
      today,
      visible: on || views.some((v) => v.state === 'open'),
      sectionOn: on,
      canWrite: can(ctx, 'advanced_analytics:write') && !ctx.isImpersonating,
      audience,
      template: {
        cadence: config.nps.cadence,
        qualMonths: [...config.qualitative.months],
        defaults: kind === 'nps'
          ? { anonymous: config.nps.defaults.anonymous, perPerson: false, remindHalfway: config.nps.defaults.remindHalfway }
          : { ...config.qualitative.defaults },
      },
      runs: views,
      selected,
    };
  }

  // ------------------------------------------------------------------------------------------------------ parts

  private periodOf(kind: SurveyKind, input: RunInput, today: LocalDate, config: AdvancedAnalyticsConfig): string {
    if (input.opensOn < today) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.opensInPast;
      throw new InvalidRequestException(sentence, { violations: [{ field: 'opensOn', message: sentence }] });
    }
    if (input.closesOn < input.opensOn) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.closesBeforeOpen;
      throw new InvalidRequestException(sentence, { violations: [{ field: 'closesOn', message: sentence }] });
    }
    if (input.invitedRoleClasses.length === 0) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.noRoles;
      throw new InvalidRequestException(sentence, { violations: [{ field: 'invitedRoleClasses', message: sentence }] });
    }
    const period = runPeriod(kind, config.nps.cadence, input.opensOn, input.closesOn, config.qualitative.months);
    if ('conflict' in period) {
      const words = SURVEY_REFUSALS.SURVEY_RUN_CONFLICT;
      throw conflict('outside_cadence', kind === 'qual'
        ? words.outsideCadenceQual
        : config.nps.cadence === 'quarter' ? words.outsideCadenceNpsQuarter : words.outsideCadenceNpsHalf);
    }
    return period.periodKey;
  }

  private async refuseTaken(ctx: RequestContext, kind: SurveyKind, periodKey: string, except: string | null): Promise<void> {
    const taken = await this.runs.findOne(ctx, { kind, periodKey, ...(except ? { _id: { $ne: except } } : {}) });
    if (taken) throw conflict('period_taken', SURVEY_REFUSALS.SURVEY_RUN_CONFLICT.periodTaken);
  }

  /** A run that has not opened, or the refusal: `404` for another KPM's or none, `409 SURVEY_CLOSED` once it opened. */
  private async scheduled(ctx: RequestContext, runId: string, today: LocalDate): Promise<SurveyRunDocument> {
    const run = await this.runs.findById(ctx, runId);
    if (!run) throw new NotFoundException('Survey run');
    if (run.snapshot || run.opensOn <= today) {
      throw new DomainException(
        ErrorCode.SURVEY_CLOSED, SURVEY_REFUSALS.SURVEY_CLOSED.opened, HttpStatus.CONFLICT, { reason: 'opened' },
      );
    }
    return run;
  }

  private async views(ctx: RequestContext, runs: readonly SurveyRunDocument[], today: LocalDate): Promise<RunView[]> {
    return Promise.all(runs.map(async (run) => {
      const parts = run.snapshot ? await this.participation.ofRun(ctx, String(run._id)) : [];
      return {
        runId: String(run._id), kind: run.kind, periodKey: run.periodKey, opensOn: run.opensOn, closesOn: run.closesOn,
        state: runState(run, today), invitedRoleClasses: [...run.invitedRoleClasses], anonymous: run.anonymous,
        perPerson: run.perPerson, remindHalfway: run.remindHalfway,
        responses: responsesOf(parts.length, parts.filter((p) => p.submittedAt).length),
      };
    }));
  }

  /** A run's sent forms, as the results read them: answers and bands, never an author. */
  private async rows(ctx: RequestContext, runId: string): Promise<ResponseRow[]> {
    return (await this.responses.ofRun(ctx, runId)).map((r) => ({
      answers: r.answers, roleClass: r.roleClass, tenureBand: r.tenureBand, ageBand: r.ageBand,
    }));
  }
}

/** The settings a run stores: `perPerson` only for a qualitative run that is not anonymous (B-R2). */
function settings(kind: SurveyKind, input: RunInput) {
  return {
    opensOn: input.opensOn,
    closesOn: input.closesOn,
    invitedRoleClasses: [...new Set(input.invitedRoleClasses)],
    anonymous: input.anonymous,
    perPerson: kind === 'qual' && !input.anonymous && input.perPerson === true,
    remindHalfway: input.remindHalfway,
  };
}

/** What the audit log keeps of a run: its settings — never an answer (ADR-0216 §3). */
function auditable(run: SurveyRunDocument): Record<string, unknown> {
  return {
    kind: run.kind, periodKey: run.periodKey, opensOn: run.opensOn, closesOn: run.closesOn,
    invitedRoleClasses: [...run.invitedRoleClasses], anonymous: run.anonymous, perPerson: run.perPerson,
    remindHalfway: run.remindHalfway,
  };
}

function conflict(
  reason: 'period_taken' | 'outside_cadence' | 'section_off',
  sentence: (typeof SURVEY_REFUSALS.SURVEY_RUN_CONFLICT)[keyof typeof SURVEY_REFUSALS.SURVEY_RUN_CONFLICT],
): DomainException {
  return new DomainException(ErrorCode.SURVEY_RUN_CONFLICT, sentence, HttpStatus.CONFLICT, { reason });
}

function requireOffice(ctx: RequestContext): void {
  if (!ctx.membershipId) throw new NoMembershipException();
}

/**
 * **Who reads the results** (ADR-0216 §3; roles §3.9 ¶): a Super Admin's platform read and a view-as session a summary,
 * whoever it acts as; the Owner and
 * the Admins the office's; an AB or an AAB tagged *Core Leader* the office's without *Dukungan leader*; any other field
 * member `404`, as KPM analytics answers them.
 */
export function audienceOf(ctx: RequestContext): ResultsAudience {
  // P19.5-T3 AC-12 (A-R9; ADR-0215 §9, ADR-0216 §3): the Super Admin's *Lihat sebagai KPM* — a platform read of one KPM,
  // reached only through `platform_kpm_figures:read` — reads the summary, never a person's or an anonymous run's answer.
  if (ctx.isPlatformRead) return 'summary';
  if (!ctx.membershipId) throw new NoMembershipException();
  const office = ctx.membership?.isKpmOwner === true || ctx.membership?.isKpmAdmin === true;
  if (!office && !ctx.isCoreLeader) throw new NotFoundException('Advanced analytics');
  if (ctx.isImpersonating) return 'summary';
  return office ? 'office' : 'core_leader';
}
