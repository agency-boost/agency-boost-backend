import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NoMembershipException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import type { LabelPair, QualItem } from '@/modules/config/analytics-config';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { scopeFor } from '@/modules/rbac/permissions';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { NPS, SURVEY, type SurveyRoleClass } from '@/domain/constants';
import type { ReminderMoment, SurveyParticipationDocument } from './survey-participation.schema';
import type { SurveyAnswer } from './survey-response.schema';
import type { SurveyKind, SurveyRunDocument, SurveySnapshot } from './survey-run.schema';
import { SurveyOffice, filled, type SurveyOfficeView } from './survey-office';
import { SurveyOpening } from './survey-opening';
import {
  anonymised, askedQuestions, bandOf, checkAnswer, daysLeft, firstMissing, minutesFor, momentsCovered, popupFor,
  progressOf, runState, tenureBandOf, wholeYears, type AskedQuestion, type AskedType,
} from './survey-rules';
import { SurveyParticipationRepository, SurveyResponseRepository, SurveyRunRepository } from './survey.repositories';
import { SURVEY_REFUSALS } from './surveys.messages';

/** A run as a member's lists name it (*Perlu diisi*, `/surveys`, the popup). */
export interface MySurveyRun {
  runId: string;
  kind: SurveyKind;
  periodKey: string;
  opensOn: LocalDate;
  closesOn: LocalDate;
  daysLeft: number;
  answeredCount: number;
  totalCount: number;
  minutes: number;
  anonymous: boolean;
  /** Which privacy line the form carries — the list's *anonim* / *dilihat leader untuk coaching*. */
  notice: SurveySnapshot['notice'];
}

export interface PendingView {
  today: LocalDate;
  kpmCode: string;
  /** Open, not sent: the dot, the *Perlu diisi* cards, the tile's dot (C-R2). */
  open: MySurveyRun[];
  /** Sent, still open: *"Terima kasih, survei sudah diisi"* (C-R9). */
  sentOpen: { runId: string; kind: SurveyKind; periodKey: string; closesOn: LocalDate }[];
  /** Today's popup, decided by the server (C-R3 to C-R7); `null` in a view-as session, which reminds nobody. */
  popup: { moment: ReminderMoment; runIds: string[] } | null;
}

export interface SurveyListView {
  today: LocalDate;
  open: MySurveyRun[];
  /** *Riwayat*: every run the member sent, newest first, with the day it was sent. */
  history: { runId: string; kind: SurveyKind; periodKey: string; submittedOn: LocalDate }[];
}

/** One screen of the form, its tokens filled. */
export interface FormQuestion {
  kode: string;
  type: AskedType;
  text: LabelPair;
  items: QualItem[];
  askWhy: boolean;
  required: boolean;
  blockKode: string | null;
  blockTitle: LabelPair | null;
  /** The scale the screen draws: 0 to 10 for a score and *Dukungan leader*, 1 to 5 for an item; `null` otherwise. */
  scale: { min: number; max: number } | null;
}

export interface FormView {
  run: {
    runId: string; kind: SurveyKind; periodKey: string; opensOn: LocalDate; closesOn: LocalDate;
    notice: SurveySnapshot['notice']; anonymous: boolean; kpmCode: string;
  };
  /** `open` is the form; anything else answers no questions. */
  state: 'open' | 'submitted' | 'closed';
  questions: FormQuestion[];
  /** The member's saved answers — `{}` in a view-as session (ADR-0216 §3). */
  answers: Record<string, unknown>;
  answeredCount: number;
  totalCount: number;
  /** Where *Lanjutkan* opens: the first question not answered (C-R6). */
  resumeIndex: number;
  /** Q11's rows: the member's own downline leaders, by name. */
  downlineLeaders: { membershipId: string; name: string }[];
}


/**
 * **A member's surveys: the reminder's read, the list, the form, its answers and *Kirim*** (P19.5-T4; ADR-0216 §3, §5,
 * §6; C-R1 to C-R10). Only an invitee is answered: everybody else, and every run of another KPM, is `404
 * SURVEY_NOT_INVITED` (C-R1, C2-5). Every read opens the KPM's runs whose day has come first (`SurveyOpening`).
 */
@Injectable()
export class SurveysService {
  constructor(
    private readonly runs: SurveyRunRepository,
    private readonly participation: SurveyParticipationRepository,
    private readonly responses: SurveyResponseRepository,
    private readonly opening: SurveyOpening,
    private readonly office: SurveyOffice,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly clock: Clock,
  ) {}

  /** **`GET /surveys/pending`** — Home's popup and *Lainnya*'s dot and cards. */
  async pending(ctx: RequestContext): Promise<PendingView> {
    const { office, mine } = await this.mine(ctx);
    const { today } = office;
    const open = mine.filter(({ run, part }) => !part.submittedAt && runState(run, today) === 'open');
    const sentOpen = mine.filter(({ run, part }) => part.submittedAt && runState(run, today) === 'open');
    const popup = ctx.isImpersonating ? null : popupFor(open.map(({ run, part }) => ({
      run: { runId: String(run._id), opensOn: run.opensOn, closesOn: run.closesOn, remindHalfway: run.remindHalfway },
      state: { submitted: false, lastPopupOn: part.reminder?.lastPopupOn ?? null, momentsShown: part.reminder?.momentsShown ?? [] },
    })), today);
    return {
      today,
      kpmCode: office.kpmCode,
      open: open.map(({ run, part }) => this.summary(run, part, today)),
      sentOpen: sentOpen.map(({ run }) => ({ runId: String(run._id), kind: run.kind, periodKey: run.periodKey, closesOn: run.closesOn })),
      popup,
    };
  }

  /** **`GET /surveys`** — the *Survei* tile's page: the open runs first, then *Riwayat*. */
  async list(ctx: RequestContext): Promise<SurveyListView> {
    const { office, mine } = await this.mine(ctx);
    const { today, timezone } = office;
    return {
      today,
      open: mine.filter(({ run, part }) => !part.submittedAt && runState(run, today) === 'open')
        .map(({ run, part }) => this.summary(run, part, today)),
      history: mine.filter(({ part }) => part.submittedAt)
        .sort((a, b) => b.part.submittedAt!.getTime() - a.part.submittedAt!.getTime())
        .map(({ run, part }) => ({
          runId: String(run._id), kind: run.kind, periodKey: run.periodKey, submittedOn: localDayOf(part.submittedAt!, timezone),
        })),
    };
  }

  /** **`GET /surveys/:runId`** — the form, its tokens filled; a closed or sent run answers its state and no questions. */
  async form(ctx: RequestContext, runId: string): Promise<FormView> {
    const { office, run, part } = await this.invitation(ctx, runId);
    const state = part.submittedAt ? 'submitted' : runState(run, office.today) === 'open' ? 'open' : 'closed';
    const asked = askedQuestions(run.kind, run.snapshot!, part.roleClass, { downlineLeaders: part.asksDownline === true });
    const answers = ctx.isImpersonating || state !== 'open' ? {} : { ...(part.draftAnswers ?? {}) };
    const progress = progressOf(asked, answers);
    const needsDownline = state === 'open' && asked.some((q) => q.type === 'downline_areas');
    return {
      run: {
        runId, kind: run.kind, periodKey: run.periodKey, opensOn: run.opensOn, closesOn: run.closesOn,
        notice: run.snapshot!.notice, anonymous: run.anonymous, kpmCode: office.kpmCode,
      },
      state,
      questions: state === 'open' ? asked.map((q) => this.shown(q, office)) : [],
      answers,
      answeredCount: ctx.isImpersonating ? part.answeredCount : progress.answeredCount,
      totalCount: asked.length,
      resumeIndex: ctx.isImpersonating ? 0 : progress.resumeIndex,
      downlineLeaders: needsDownline ? await this.downlineLeaders(ctx) : [],
    };
  }

  /** **`PUT /surveys/:runId/answers/:questionKode`** — *Tersimpan otomatis*: one answer saved as it is given (C-R6). */
  async answer(ctx: RequestContext, runId: string, kode: string, value: unknown): Promise<{ answeredCount: number; totalCount: number }> {
    const { office, run, part } = await this.invitation(ctx, runId);
    this.refuseClosed(run, part, office.today);
    const asked = askedQuestions(run.kind, run.snapshot!, part.roleClass, { downlineLeaders: part.asksDownline === true });
    const question = asked.find((q) => q.kode === kode);
    if (!question) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.unknownQuestion({ kode });
      throw new InvalidRequestException(sentence, { violations: [{ field: 'questionKode', message: sentence }] });
    }
    const downline = question.type === 'downline_areas'
      ? new Set((await this.downlineLeaders(ctx)).map((d) => d.membershipId))
      : new Set<string>();
    const checked = checkAnswer(question, value, downline);
    if ('problem' in checked) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.answer({ kode, problem: checked.problem });
      throw new InvalidRequestException(sentence, { violations: [{ field: 'value', message: sentence }] });
    }
    const draft = { ...(part.draftAnswers ?? {}), [kode]: checked.value };
    const { answeredCount } = progressOf(asked, draft);
    const saved = await this.participation.saveDraft(ctx, String(part._id), draft, answeredCount, kode);
    if (!saved) throw this.closed('submitted');
    return { answeredCount, totalCount: asked.length };
  }

  /**
   * **`POST /surveys/:runId/submit`** — *Kirim* (ADR-0216 §3, §5): every required question answered, else `400` naming
   * the first. The participation row is marked sent and its draft cleared **first**, so a second *Kirim* finds it sent;
   * then the form is written — with no person on it for an anonymous run.
   */
  async submit(ctx: RequestContext, runId: string): Promise<{ submittedAt: string }> {
    const { office, run, part } = await this.invitation(ctx, runId);
    this.refuseClosed(run, part, office.today);
    const asked = askedQuestions(run.kind, run.snapshot!, part.roleClass, { downlineLeaders: part.asksDownline === true });
    const draft = part.draftAnswers ?? {};
    const missing = firstMissing(asked, draft);
    if (missing) {
      const sentence = SURVEY_REFUSALS.VALIDATION_FAILED.missing({ kode: missing });
      throw new InvalidRequestException(sentence, { violations: [{ field: missing, message: sentence }] });
    }
    const answers: SurveyAnswer[] = asked
      .filter((q) => draft[q.kode] !== undefined)
      .map((q) => {
        const value = draft[q.kode] as Record<string, unknown>;
        return { questionKode: q.kode, value: run.anonymous ? anonymised(q, value) : value };
      });
    const bands = await this.bands(ctx, run.snapshot!, part.roleClass, office.today);
    const at = this.clock.now();
    const { answeredCount } = progressOf(asked, draft);
    const marked = await this.participation.markSubmitted(ctx, String(part._id), at, answeredCount);
    if (!marked) throw this.closed('submitted');
    try {
      if (run.anonymous) {
        await this.responses.insertAnonymous(ctx, { runId, answers, ...bands });
      } else {
        await this.responses.insertNamed(ctx, {
          runId, answers, ...bands, submittedAt: at, noticeShown: run.snapshot!.notice === 'per_person',
        });
      }
    } catch (err) {
      // The form was not written: give the draft back, so *Kirim* can be tried again.
      await this.participation.updateById(ctx, String(part._id), {
        $set: { submittedAt: null, draftAnswers: draft },
      });
      throw err;
    }
    return { submittedAt: at.toISOString() };
  }

  /** **`POST /surveys/popup/shown`** — the popup was drawn: none again this KPM day, on any device (C-R3, C-R4). */
  async popupShown(ctx: RequestContext, moment: ReminderMoment, runIds: readonly string[]): Promise<void> {
    const today = await this.office.today(ctx);
    await this.participation.popupShown(ctx, runIds, today, momentsCovered(moment));
  }

  // ------------------------------------------------------------------------------------------------------ parts

  private async mine(ctx: RequestContext): Promise<{
    office: SurveyOfficeView; mine: { run: SurveyRunDocument; part: SurveyParticipationDocument }[];
  }> {
    requireRespondent(ctx);
    const office = await this.office.of(ctx);
    await this.opening.openDue(ctx, office.today);
    const parts = await this.participation.mine(ctx);
    if (parts.length === 0) return { office, mine: [] };
    const runs = await this.runs.find(ctx, { _id: { $in: parts.map((p) => p.runId) }, snapshot: { $ne: null } });
    const byId = new Map(runs.map((r) => [String(r._id), r]));
    return {
      office,
      mine: parts.flatMap((part) => (byId.has(part.runId) ? [{ run: byId.get(part.runId)!, part }] : []))
        .sort((a, b) => (a.run.closesOn < b.run.closesOn ? -1 : 1)),
    };
  }

  /** The caller's invitation to one run, or `404 SURVEY_NOT_INVITED` — for another KPM's, an unknown or a cancelled run too. */
  private async invitation(ctx: RequestContext, runId: string): Promise<{
    office: SurveyOfficeView; run: SurveyRunDocument; part: SurveyParticipationDocument;
  }> {
    requireRespondent(ctx);
    const office = await this.office.of(ctx);
    await this.opening.openDue(ctx, office.today);
    const run = await this.runs.findById(ctx, runId);
    const part = run?.snapshot ? await this.participation.of(ctx, runId, ctx.membershipId!) : null;
    if (!run || !part) {
      throw new DomainException(ErrorCode.SURVEY_NOT_INVITED, SURVEY_REFUSALS.SURVEY_NOT_INVITED.notInvited, HttpStatus.NOT_FOUND);
    }
    return { office, run, part };
  }

  private refuseClosed(run: SurveyRunDocument, part: SurveyParticipationDocument, today: LocalDate): void {
    if (part.submittedAt) throw this.closed('submitted');
    if (runState(run, today) !== 'open') throw this.closed('closed');
  }

  private closed(reason: 'closed' | 'submitted'): DomainException {
    return new DomainException(
      ErrorCode.SURVEY_CLOSED, SURVEY_REFUSALS.SURVEY_CLOSED[reason], HttpStatus.CONFLICT, { reason },
    );
  }

  private summary(run: SurveyRunDocument, part: SurveyParticipationDocument, today: LocalDate): MySurveyRun {
    const total = askedQuestions(run.kind, run.snapshot!, part.roleClass, { downlineLeaders: part.asksDownline === true }).length;
    return {
      runId: String(run._id), kind: run.kind, periodKey: run.periodKey, opensOn: run.opensOn, closesOn: run.closesOn,
      daysLeft: daysLeft(today, run.closesOn), answeredCount: part.answeredCount, totalCount: total,
      minutes: minutesFor(total), anonymous: run.anonymous, notice: run.snapshot!.notice,
    };
  }

  private shown(q: AskedQuestion, office: SurveyOfficeView): FormQuestion {
    return {
      kode: q.kode, type: q.type, text: filled(q.text, office), items: q.items, askWhy: q.askWhy, required: q.required,
      blockKode: q.blockKode, blockTitle: q.blockTitle ? filled(q.blockTitle, office) : null,
      scale: q.type === 'score' || q.type === 'support'
        ? { min: NPS.SCALE_MIN, max: NPS.SCALE_MAX }
        : q.type === 'scale_items' || q.type === 'unit_items' ? { min: 1, max: SURVEY.RATING_MAX } : null,
    };
  }

  /** The caller's own direct reports who lead — Q11's rows — by name. */
  private async downlineLeaders(ctx: RequestContext): Promise<{ membershipId: string; name: string }[]> {
    const members = await this.memberships.find(
      ctx, { leaderId: ctx.membershipId, status: 'active', role: { $in: ['aab', 'ab'] } }, { sort: { agentSeq: 1 } },
    );
    const names = await this.names.byMembershipId(ctx, members.map((m) => String(m._id)));
    return members.map((m) => ({ membershipId: String(m._id), name: names.get(String(m._id)) ?? '' }));
  }

  /**
   * **The bands a form is stored with**, read from the member list when it is sent and banded by the run's snapshot
   * (ADR-0216 §3): the role class it was invited as, the tenure from the KPM join date (OD-254 Q8) and the age from
   * the birth date. A blank one is `null` — *Belum diisi* — and is never asked.
   */
  private async bands(ctx: RequestContext, snapshot: SurveySnapshot, roleClass: SurveyRoleClass, today: LocalDate): Promise<{
    roleClass: SurveyRoleClass; tenureBand: number | null; ageBand: number | null;
  }> {
    const member = await this.memberships.findById(ctx, ctx.membershipId!);
    const user = member ? await this.users.findById(member.userId, { dateOfBirth: 1 }).lean().exec() : null;
    const joinDate = member?.joinDate ?? null;
    const dob = (user as { dateOfBirth?: string | null } | null)?.dateOfBirth ?? null;
    return {
      roleClass,
      tenureBand: joinDate ? tenureBandOf(wholeYears(joinDate, today), snapshot.cutoffs.tenureBands) : null,
      ageBand: dob ? bandOf(wholeYears(dob, today), snapshot.cutoffs.ageBandUpper) : null,
    };
  }
}

/**
 * **`survey:respond`, held** (roles §3.8; ADR-0216 §8): every tenant role, `own`. The reads declare no permission on the
 * route, because a view-as session reads them as its member does and `survey:respond` is not a read by its verb
 * (`can()` refuses a session every write); the writes declare it, and `ViewOnlySessionGuard` refuses a session's first.
 */
export function requireRespondent(ctx: RequestContext): void {
  if (!ctx.membershipId) throw new NoMembershipException();
  if (scopeFor(ctx, 'survey:respond') === null) throw new PermissionDeniedException('survey:respond');
}
