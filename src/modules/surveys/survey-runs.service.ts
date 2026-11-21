import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { canOpenMember, officeStewardKind, requireOfficeSteward } from '@/common/auth/office-steward';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { LocalDate } from '@/common/time/local-day';
import { SURVEY_ROLE_CLASSES, type SurveyRoleClass } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import type { AdvancedAnalyticsConfig, LabelPair } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can } from '@/modules/rbac/permissions';
import type { SurveyKind, SurveyRunDocument, SurveySnapshot } from './survey-run.schema';
import type { SurveyParticipationDocument } from './survey-participation.schema';
import { SurveyOffice } from './survey-office';
import { SurveyOpening, sectionOn, snapshotOf } from './survey-opening';
import {
  npsHeadlineOf, npsResults, qualResults, responsesOf, type NpsHistoryRun, type NpsResults, type QualResults,
  type ResultsAudience, type ResponseRow, type SurveyWho,
} from './survey-results';
import { askedQuestions, isLeaderClass, minutesFor, periodBounds, periodOf, runPeriod, runState, type RunState } from './survey-rules';
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
  /**
   * *x dari y menjawab · n leader · n agent* (`SURVEY_RESPONSE_RATE`): forms sent of the invitees, and how many of those
   * sent were leaders (AB, AAB) and agents; `0` of `0` before it opens.
   */
  responses: { sent: number; invited: number; pct: number | null; leaders: number; agents: number };
  /** *Survei sebelumnya*'s *NPS 62%* — `NPS_KPM_OVERALL` over every form; `null` for a qualitative run or under the floor. */
  headlineScore: number | null;
}

/** One question or block of *Pratinjau survei*: what the next run asks, from the published template. */
export interface PreviewLine {
  /** *Q5*, or *Q8–Q9* for a block of two; an NPS question's own kode. */
  kodes: string[];
  text: LabelPair;
  type: string;
  audience: 'all' | 'leader';
  /** Its items: *nilai 1–5 untuk 7 aspek*. */
  items: number;
}

/** A member not answered yet, as *Belum menjawab* lists them. */
export interface NotAnsweredPerson {
  membershipId: string;
  name: string;
  roleClass: SurveyRoleClass;
}

/**
 * ***Survei baru*** (P19.22-T6 AC-3, T7 AC-4; ADR-0276 §2): the period a run may be sent for now, what it asks, how many
 * it goes to, and — once sent — its live progress and who has not answered.
 */
export interface SendView {
  /** The quarter (or half) of today for NPS; for a qualitative run this June or December, or the next one. */
  periodKey: string;
  /** Today, or the first day of the qualitative month when that is still to come (the run is then scheduled). */
  opensOn: LocalDate;
  /** *Tutup*: the last day of the period, the latest it may close and the date it starts on. */
  closesOnMax: LocalDate;
  /** *Kirim ke n anggota*: the active members of the KPM it would invite — every role, test accounts never. */
  invitable: number;
  /** The period's run, once sent: scheduled, open or closed. */
  run: RunView | null;
  /** The period's run's invitees who have not sent it; `null` before it opens and for a summary (no names). */
  notAnswered: NotAnsweredPerson[] | null;
  preview: PreviewLine[];
  /** *±m menit*: the questions a leader is asked, at `SURVEY.SECONDS_PER_QUESTION` each. */
  minutes: number;
}

export interface ResultsView {
  kind: SurveyKind;
  today: LocalDate;
  /** The tab is shown: its section on in the template, or a run of it still open (AT-12, AA UI-022). */
  visible: boolean;
  sectionOn: boolean;
  /** *Kirim*, *Tutup* and *Batalkan*: a steward's (`advanced_analytics:write`), never in a view-as session. */
  canWrite: boolean;
  audience: ResultsAudience;
  who: SurveyWho;
  /** The template's cadence and the run defaults a run is sent with (spec §2; C-R10). */
  template: {
    cadence: 'quarter' | 'half';
    qualMonths: number[];
    defaults: { anonymous: boolean; perPerson: boolean; remindHalfway: boolean };
  };
  runs: RunView[];
  selected: (RunView & { previousRunId: string | null; nps: NpsResults | null; qual: QualResults | null }) | null;
  send: SendView;
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

/** How many runs an NPS trend is drawn over, this one included: *4-quarter trend* (ADR-0276 §1). */
export const NPS_TREND_RUNS = 4;

/**
 * **A KPM's survey runs and their results** (P19.5-T4, rebuilt by P19.22-T6, T7; ADR-0216 §2, §4; ADR-0276). A steward —
 * the Super Admin inside the KPM, the Owner, an Admin, a core leader (ADR-0268) — sends a run within the template's
 * cadence (*Survei baru*) and changes its closing day or cancels it until it opens; the results are read by them in
 * their audience's shape, and by a platform read or a view-as session as a summary.
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
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
  ) {}

  /** **`POST /kpm/advanced-analytics/surveys/runs`** — *Kirim ke n anggota* (P19.22-T6 AC-3; AC-1 of P19.5-T4). */
  async create(ctx: RequestContext, kind: SurveyKind, input: RunInput): Promise<RunView> {
    requireOfficeSteward(ctx, 'Advanced analytics');
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

  /** **`PATCH …/surveys/runs/:runId`** — before it opens only (*Tutup* of a scheduled run); afterwards `409 SURVEY_CLOSED`. */
  async update(ctx: RequestContext, runId: string, input: Partial<RunInput>): Promise<RunView> {
    requireOfficeSteward(ctx, 'Advanced analytics');
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
    requireOfficeSteward(ctx, 'Advanced analytics');
    const today = await this.office.today(ctx);
    const run = await this.scheduled(ctx, runId, today);
    await this.runs.softDeleteById(ctx, runId, this.clock.now());
    await this.audit.record(ctx, {
      action: 'survey_run.cancelled', targetCollection: 'surveyRuns', targetId: runId, before: auditable(run),
    });
  }

  /**
   * **`GET /kpm/advanced-analytics/nps` · `…/qual`** — the runs, newest first, one run's results in one view (`who`), and
   * *Survei baru* (P19.22-T6, T7): `runId` named, else the newest that has opened. In the audience's shape (ADR-0276 §5).
   */
  async results(ctx: RequestContext, kind: SurveyKind, runId?: string, who: SurveyWho = 'all'): Promise<ResultsView> {
    const audience = audienceOf(ctx);
    const today = await this.office.today(ctx);
    // P19.5-T3 AC-12 (ADR-0207 §4): a Super Admin's platform read writes nothing in the KPM, a run's opening included.
    if (!ctx.isPlatformRead) await this.opening.openDue(ctx, today);
    const published = await this.config.publishedFor(ctx);
    const { config } = published;
    const runs = await this.runs.list(ctx, kind);
    const opened = runs.filter((r) => r.snapshot);
    const formsOf = memo((id: string) => this.rows(ctx, id));
    const views = await this.views(ctx, runs, today, formsOf);
    const on = sectionOn(config, kind);
    const chosen = runId ? runs.find((r) => String(r._id) === runId) : opened[0];
    if (runId && !chosen) throw new NotFoundException('Survey run');
    let selected: ResultsView['selected'] = null;
    if (chosen) {
      const view = views.find((v) => v.runId === String(chosen._id))!;
      const earlier = opened.filter((r) => r.periodKey < chosen.periodKey);
      const asRun = async (r: SurveyRunDocument): Promise<NpsHistoryRun> => ({
        snapshot: r.snapshot!, rows: await formsOf(String(r._id)), anonymous: r.anonymous, periodKey: r.periodKey,
      });
      const history = kind === 'nps' && chosen.snapshot
        ? await Promise.all(earlier.slice(0, NPS_TREND_RUNS - 1).reverse().map(asRun))
        : [];
      const previous = earlier[0] ?? null;
      selected = {
        ...view,
        previousRunId: previous ? String(previous._id) : null,
        nps: kind === 'nps' && chosen.snapshot ? npsResults(await asRun(chosen), audience, history, who) : null,
        qual: kind === 'qual' && chosen.snapshot
          ? await this.named(ctx, qualResults(
            await asRun(chosen), audience, config.thresholds, previous?.snapshot ? await asRun(previous) : null, who,
          ))
          : null,
      };
    }
    return {
      kind,
      today,
      visible: on || views.some((v) => v.state === 'open'),
      sectionOn: on,
      canWrite: can(ctx, 'advanced_analytics:write') && !ctx.isImpersonating && !ctx.isPlatformRead,
      audience,
      who,
      template: {
        cadence: config.nps.cadence,
        qualMonths: [...config.qualitative.months],
        defaults: kind === 'nps'
          ? { anonymous: config.nps.defaults.anonymous, perPerson: false, remindHalfway: config.nps.defaults.remindHalfway }
          : { ...config.qualitative.defaults },
      },
      runs: views,
      selected,
      send: await this.sendView(ctx, kind, published, today, runs, views, audience),
    };
  }

  // ------------------------------------------------------------------------------------------------------ parts

  /** ***Survei baru*** (ADR-0276 §2): the period sendable now, its run if sent, who has not answered, and the preview. */
  private async sendView(
    ctx: RequestContext, kind: SurveyKind, published: Awaited<ReturnType<AnalyticsConfigReader['publishedFor']>>,
    today: LocalDate, runs: readonly SurveyRunDocument[], views: readonly RunView[], audience: ResultsAudience,
  ): Promise<SendView> {
    const { config } = published;
    const { periodKey, opensOn } = sendablePeriod(kind, today, config);
    const run = runs.find((r) => r.periodKey === periodKey) ?? null;
    const runView = run ? views.find((v) => v.runId === String(run._id)) ?? null : null;
    const invitable = await this.memberships.count(ctx, {
      status: 'active', role: { $in: [...SURVEY_ROLE_CLASSES] }, ...NOT_A_TEST_ACCOUNT,
    });
    let notAnswered: NotAnsweredPerson[] | null = null;
    if (run?.snapshot && audience !== 'summary') {
      const waiting = (await this.participation.ofRun(ctx, String(run._id))).filter((p) => !p.submittedAt);
      const counted = new Set((await this.memberships.find(
        ctx, { _id: { $in: waiting.map((p) => p.membershipId) }, ...NOT_A_TEST_ACCOUNT }, { projection: { _id: 1 } },
      )).map((m) => String(m._id)));
      const names = await this.names.byMembershipId(ctx, [...counted]);
      notAnswered = waiting
        .filter((p) => counted.has(p.membershipId) && names.has(p.membershipId))
        .map((p) => ({ membershipId: p.membershipId, name: names.get(p.membershipId)!, roleClass: p.roleClass }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
    }
    const snapshot = run?.snapshot ?? snapshotOf({ kind, anonymous: true, perPerson: false }, published);
    return {
      periodKey,
      opensOn: run ? run.opensOn : opensOn,
      closesOnMax: periodBounds(periodKey).last,
      invitable,
      run: runView,
      notAnswered,
      preview: previewOf(kind, snapshot),
      minutes: minutesFor(askedQuestions(kind, snapshot, 'ab').length),
    };
  }

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

  private async views(
    ctx: RequestContext, runs: readonly SurveyRunDocument[], today: LocalDate,
    formsOf: (runId: string) => Promise<ResponseRow[]> = (id) => this.rows(ctx, id),
  ): Promise<RunView[]> {
    return Promise.all(runs.map(async (run) => {
      const parts: SurveyParticipationDocument[] = run.snapshot ? await this.participation.ofRun(ctx, String(run._id)) : [];
      const sent = parts.filter((p) => p.submittedAt);
      const leaders = sent.filter((p) => isLeaderClass(p.roleClass)).length;
      return {
        runId: String(run._id), kind: run.kind, periodKey: run.periodKey, opensOn: run.opensOn, closesOn: run.closesOn,
        state: runState(run, today), invitedRoleClasses: [...run.invitedRoleClasses], anonymous: run.anonymous,
        perPerson: run.perPerson, remindHalfway: run.remindHalfway,
        responses: responsesOf(parts.length, sent.length, leaders, sent.length - leaders),
        headlineScore: run.kind === 'nps' && run.snapshot
          ? npsHeadlineOf({ snapshot: run.snapshot, rows: await formsOf(String(run._id)), anonymous: run.anonymous })
          : null,
      };
    }));
  }

  /**
   * ***Coaching leader downline*'s table, named** (P19.22-T7 AC-2; ADR-0276 §5): each row is one leader's answer about
   * their own downline leader, so a core leader sees only the rows whose upline is themselves or in their downline, as
   * *Per orang* opens only them; the rest are left out. Names as the office reads them now, in one read.
   */
  private async named(ctx: RequestContext, qual: QualResults): Promise<QualResults> {
    const rows = qual.coachingDownline.rows;
    if (!rows || rows.length === 0) return qual;
    const ids = [...new Set(rows.flatMap((r) => [r.leaderId, r.uplineId]))];
    const lines = await this.memberships.find(ctx, { _id: { $in: rows.map((r) => r.uplineId) } }, { projection: { ancestorIds: 1 } });
    const reach = new Map(lines.map((m) => [String(m._id), canOpenMember(ctx, { membershipId: String(m._id), ancestorIds: m.ancestorIds ?? [] })]));
    const names = await this.names.byMembershipId(ctx, ids);
    return {
      ...qual,
      coachingDownline: {
        ...qual.coachingDownline,
        rows: rows.filter((r) => reach.get(r.uplineId) === true).map((r) => ({
          ...r, leaderName: names.get(r.leaderId) ?? '', uplineName: names.get(r.uplineId) ?? '',
        })),
      },
    };
  }

  /** A run's sent forms, as the results read them: answers, bands, and on a named run who sent each. */
  private async rows(ctx: RequestContext, runId: string): Promise<ResponseRow[]> {
    return (await this.responses.ofRun(ctx, runId)).map((r) => ({
      answers: r.answers, roleClass: r.roleClass, tenureBand: r.tenureBand, ageBand: r.ageBand,
      workStatus: r.workStatus ?? null, membershipId: r.membershipId ?? null,
    }));
  }
}

/** A function of a key, called once per key. */
function memo<T>(fn: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>();
  return (key) => {
    if (!seen.has(key)) seen.set(key, fn(key));
    return seen.get(key)!;
  };
}

/**
 * **The period *Survei baru* sends for** (ADR-0276 §2): NPS — today's quarter or half, opening today; a qualitative
 * run — today's month when it is June or December, opening today, else the next of the two, opening on its first day.
 */
export function sendablePeriod(
  kind: SurveyKind, today: LocalDate, config: Pick<AdvancedAnalyticsConfig, 'nps' | 'qualitative'>,
): { periodKey: string; opensOn: LocalDate } {
  const now = periodOf(kind, config.nps.cadence, today, config.qualitative.months);
  if (now) return { periodKey: now, opensOn: today };
  const [y, m] = today.split('-').map(Number);
  const months = [...config.qualitative.months].sort((a, b) => a - b);
  const month = months.find((q) => q > m) ?? months[0];
  const year = month > m ? y : y + 1;
  const key = `${year}-${String(month).padStart(2, '0')}`;
  return { periodKey: key, opensOn: periodBounds(key).first };
}

/** *Pratinjau survei*: NPS's questions and its open one; a qualitative run's blocks after *Tentang Anda* (from the profile). */
export function previewOf(kind: SurveyKind, snapshot: SurveySnapshot): PreviewLine[] {
  if (kind === 'nps') {
    return [
      ...snapshot.questions.map((q) => ({ kodes: [q.kode], text: q.text, type: 'score', audience: 'all' as const, items: 0 })),
      ...(snapshot.openQuestion ? [{ kodes: [snapshot.openQuestion.kode], text: snapshot.openQuestion.text, type: 'text', audience: 'all' as const, items: 0 }] : []),
    ];
  }
  return snapshot.blocks
    .filter((b) => b.questions.some((q) => q.type !== 'choice'))
    .map((b) => {
      const main = b.questions.find((q) => q.type === 'unit_items') ?? b.questions[0];
      return {
        kodes: b.questions.map((q) => q.kode), text: b.title, audience: b.audience,
        type: b.questions.some((q) => q.type === 'unit_items') ? 'unit_items' : main.type,
        items: Math.max(...b.questions.map((q) => q.items.length)),
      };
    });
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

/**
 * **Who reads the results** (ADR-0216 §3, amended by ADR-0276 §5; ADR-0268): a Super Admin's platform read and a
 * view-as session a summary, whoever it acts as; the Super Admin inside the KPM, the Owner and the Admins the office's;
 * a core leader the office's without *Suara responden*; anybody else of the KPM `404`, as KPM analytics answers them.
 * A request in no KPM is `403 TENANT_NO_MEMBERSHIP`.
 */
export function audienceOf(ctx: RequestContext): ResultsAudience {
  // P19.5-T3 AC-12 (A-R9; ADR-0215 §9, ADR-0216 §3): the Super Admin's *Lihat sebagai KPM* — a platform read of one KPM,
  // reached only through `platform_kpm_figures:read` — reads the summary, never a person's or an anonymous run's answer.
  if (ctx.isPlatformRead) return 'summary';
  requireOfficeSteward(ctx, 'Advanced analytics');
  if (ctx.isImpersonating) return 'summary';
  return officeStewardKind(ctx) === 'core_leader' ? 'core_leader' : 'office';
}
