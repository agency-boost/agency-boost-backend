import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import type { SurveyRoleClass, SurveyState } from '@/domain/constants';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import type { LabelPair } from '@/modules/config/analytics-config';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { scopeFor } from '@/modules/rbac/permissions';
import { User, type UserDocument } from '@/modules/users/user.schema';
import type { SurveyResponseDocument } from './survey-response.schema';
import type { SnapshotQualBlock, SurveyRunDocument } from './survey-run.schema';
import { SurveyOffice, filled } from './survey-office';
import { SurveyOpening } from './survey-opening';
import { bandOf, isIssue, isLeaderClass, runState, wholeYears } from './survey-rules';
import { SurveyParticipationRepository, SurveyResponseRepository, SurveyRunRepository } from './survey.repositories';
import { SURVEY_REFUSALS } from './surveys.messages';

/** One section card of the tab, as the mockup draws it (B2). */
export type CoachingSection =
  | { kode: string; kind: 'scale'; title: LabelPair; questionKodes: string[]; items: { kode: string; label: LabelPair; rating: number | null }[] }
  | { kode: string; kind: 'state'; title: LabelPair; questionKodes: string[]; items: { kode: string; label: LabelPair; state: SurveyState | null }[] }
  | {
    kode: string; kind: 'unit'; title: LabelPair; questionKodes: string[];
    items: { kode: string; label: LabelPair; state: SurveyState | null; rating: number | null }[];
  }
  | {
    kode: string; kind: 'downline'; title: LabelPair; questionKodes: string[]; stillCoaching: boolean | null;
    leaders: { membershipId: string | null; name: string; areas: { kode: string; label: LabelPair }[] }[];
  };

export interface CoachingSurveyView {
  /** `answered` · `not_answered` · `anonymous` · `none` (ADR-0216 §7). */
  state: 'answered' | 'not_answered' | 'anonymous' | 'none';
  run: { runId: string; periodKey: string; opensOn: LocalDate; closesOn: LocalDate; submittedOn: LocalDate | null } | null;
  /** The bar *Waktu · Masa kerja · Usia · Gen*, from the member list; `null` unless `answered`. */
  person: {
    roleClass: SurveyRoleClass; workStatus: string | null; tenureYears: number | null; age: number | null;
    generation: number | null;
  } | null;
  /** The snapshot's cut-off: *1–n = masalah*, red at it or below (B-R6, AC-17). */
  issueMaxRating: number | null;
  /** *Item bermasalah*: one count per section card (`QUAL_PERSON_ISSUE_COUNT`). */
  issueCounts: { kode: string; title: LabelPair; count: number }[];
  /** Q4: the options, the chosen ones ticked, and the note. */
  aspiration: { kode: string; options: { kode: string; label: LabelPair; chosen: boolean }[]; note: string | null } | null;
  sections: CoachingSection[];
}

const empty = (): Pick<CoachingSurveyView, 'person' | 'issueMaxRating' | 'issueCounts' | 'aspiration' | 'sections'> => ({
  person: null, issueMaxRating: null, issueCounts: [], aspiration: null, sections: [],
});

/**
 * **`GET /coaching/:membershipId/survey` — the coaching *Survei* tab** (P19.5-T4; ADR-0216 §3, §7; B-R1 to B-R3, B3,
 * B4; AC-14 to AC-19).
 *
 * **Checked before anything is read of the person's answers:**
 * 1. a view-as session is `403 SURVEY_ANSWERS_HIDDEN`, whoever it acts as (A-R9, A5-6);
 * 2. a person of another KPM, or none, is `404`;
 * 3. the reader can open the person's coaching page — the Owner and the Admins (`own-kpm`), an upline (`COACH`,
 *    `own-downline`) — else **`404`**, as every subject read beyond its scope answers (`rbac/permissions.ts`, P11-T3
 *    AC-3; B4-6, OD-261; ADR-0216 §3, amended 2026-11-06): a `403` would confirm that the person is in the office;
 * 4. the run's flags: not anonymous, `perPerson` on, and the form carried B-R4's notice — else `anonymous`, and **no
 *    answer crosses the network** (B4-4).
 *
 * The tab shows the person's latest qualitative run that invited them — the latest closed or sent one, else the one
 * still open. **NPS runs never appear here, and Q12 never leaves the server.** Opening it writes the §3.5 entry,
 * surface `survey` (AC-19).
 */
@Injectable()
export class CoachingSurveyService {
  constructor(
    private readonly runs: SurveyRunRepository,
    private readonly participation: SurveyParticipationRepository,
    private readonly responses: SurveyResponseRepository,
    private readonly opening: SurveyOpening,
    private readonly office: SurveyOffice,
    private readonly memberships: MembershipRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly subjectReads: SubjectReadAudit,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async read(ctx: RequestContext, membershipId: string): Promise<CoachingSurveyView> {
    if (ctx.isImpersonating) throw hidden('session');
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();
    const member = await this.memberships.findById(ctx, membershipId);
    if (!member) throw new NotFoundException('Membership');
    const scope = scopeFor(ctx, 'survey_answers:read');
    const reaches = scope === 'own-kpm' || scope === 'all'
      ? true
      : scope === 'own-downline' && await this.coach.coaches(ctx, me, membershipId);
    // ADR-0216 §3 (amended 2026-11-06): a reader outside the person's line is answered as one in another office.
    if (!reaches) throw new NotFoundException('Membership');

    const office = await this.office.of(ctx);
    await this.opening.openDue(ctx, office.today);
    const run = await this.latestRun(ctx, membershipId, office.today);
    await this.subjectReads.record(ctx, { membershipId }, 'survey', run
      ? { from: run.run.opensOn, to: run.run.closesOn }
      : { from: null, to: office.today });
    if (!run) return { state: 'none', run: null, ...empty() };

    const { run: r, submittedAt } = run;
    const runView = {
      runId: String(r._id), periodKey: r.periodKey, opensOn: r.opensOn, closesOn: r.closesOn,
      submittedOn: submittedAt ? localDayOf(submittedAt, office.timezone) : null,
    };
    if (r.anonymous || !r.perPerson) return { state: 'anonymous', run: runView, ...empty() };
    if (!submittedAt) return { state: 'not_answered', run: runView, ...empty() };
    const response = await this.responses.ofPerson(ctx, String(r._id), membershipId);
    if (!response || !response.noticeShown) return { state: 'anonymous', run: runView, ...empty() };

    const roleClass = run.roleClass;
    const user = await this.users.findById(member.userId, { dateOfBirth: 1 }).lean().exec();
    const dob = (user as { dateOfBirth?: string | null } | null)?.dateOfBirth ?? null;
    const age = dob ? wholeYears(dob, office.today) : null;
    const blocks = r.snapshot!.blocks.filter((b) => b.audience === 'all' || isLeaderClass(roleClass));
    const max = r.snapshot!.cutoffs.qualIssueMaxRating!;
    const sections = await this.sections(ctx, blocks, response, office);
    return {
      state: 'answered',
      run: runView,
      person: {
        roleClass,
        workStatus: member.workStatus ?? null,
        tenureYears: member.joinDate ? wholeYears(member.joinDate, office.today) : null,
        age,
        generation: age === null ? null : bandOf(age, r.snapshot!.cutoffs.ageBandUpper),
      },
      issueMaxRating: max,
      issueCounts: sections.filter((s) => s.kind !== 'downline').map((s) => ({ kode: s.kode, title: s.title, count: issuesIn(s, max) })),
      aspiration: this.aspiration(blocks, response, office),
      sections,
    };
  }

  /** The latest qualitative run that invited the person: closed or sent first, else the one still open. */
  private async latestRun(ctx: RequestContext, membershipId: string, today: LocalDate): Promise<{
    run: SurveyRunDocument; submittedAt: Date | null; roleClass: SurveyRoleClass;
  } | null> {
    const parts = await this.participation.find(ctx, { membershipId });
    if (parts.length === 0) return null;
    const runs = await this.runs.find(
      ctx, { _id: { $in: parts.map((p) => p.runId) }, kind: 'qual', snapshot: { $ne: null } }, { sort: { opensOn: -1 } },
    );
    const withPart = runs.map((run) => {
      const part = parts.find((p) => p.runId === String(run._id))!;
      return { run, submittedAt: part.submittedAt, roleClass: part.roleClass };
    });
    return withPart.find((x) => x.submittedAt || runState(x.run, today) === 'closed') ?? withPart[0] ?? null;
  }

  private aspiration(blocks: readonly SnapshotQualBlock[], response: SurveyResponseDocument, office: { company: string; kpm: string }) {
    const q = blocks.flatMap((b) => b.questions).find((x) => x.type === 'aspiration');
    if (!q) return null;
    const value = answerOf(response, q.kode);
    const chosen = Array.isArray(value?.chosen) ? (value!.chosen as string[]) : [];
    return {
      kode: q.kode,
      options: q.items.map((it) => ({ kode: it.kode, label: filled(it.label, office), chosen: chosen.includes(it.kode) })),
      note: typeof value?.note === 'string' ? value.note : null,
    };
  }

  /** The cards, one per block, by what its questions ask — never `support` (Q12) and never a `choice`. */
  private async sections(
    ctx: RequestContext, blocks: readonly SnapshotQualBlock[], response: SurveyResponseDocument,
    office: { company: string; kpm: string },
  ): Promise<CoachingSection[]> {
    const out: CoachingSection[] = [];
    for (const b of blocks) {
      const qs = b.questions;
      const title = filled(b.title, office);
      const questionKodes = qs.map((q) => q.kode);
      const unit = qs.find((q) => q.type === 'unit_items');
      const scale = qs.find((q) => q.type === 'scale_items');
      const state = qs.find((q) => q.type === 'state_items');
      const downline = qs.filter((q) => q.type === 'downline_coaching');
      if (unit) {
        const comfort = answerOf(response, unit.kode) ?? {};
        const states = state ? answerOf(response, state.kode) ?? {} : {};
        out.push({
          kode: b.kode, kind: 'unit', title, questionKodes,
          items: unit.items.map((it) => ({
            kode: it.kode, label: it.label,
            state: (states[it.kode] as SurveyState | undefined) ?? null,
            rating: typeof comfort[it.kode] === 'number' ? (comfort[it.kode] as number) : null,
          })),
        });
      } else if (scale) {
        const v = answerOf(response, scale.kode) ?? {};
        out.push({
          kode: b.kode, kind: 'scale', title, questionKodes,
          items: scale.items.map((it) => ({ kode: it.kode, label: it.label, rating: typeof v[it.kode] === 'number' ? (v[it.kode] as number) : null })),
        });
      } else if (state) {
        const v = answerOf(response, state.kode) ?? {};
        out.push({
          kode: b.kode, kind: 'state', title, questionKodes,
          items: state.items.map((it) => ({ kode: it.kode, label: it.label, state: (v[it.kode] as SurveyState | undefined) ?? null })),
        });
      } else if (downline.length > 0) {
        const yesNo = downline.find((q) => q.items.length === 0);
        const areasQ = downline.find((q) => q.items.length > 0);
        const answer = yesNo ? answerOf(response, yesNo.kode)?.answer : undefined;
        const rows = areasQ ? ((answerOf(response, areasQ.kode)?.leaders as { membershipId?: string; areas: string[] }[] | undefined) ?? []) : [];
        // Not asked — a leader with no leader below them (Ika in the mockup) — so no card.
        if (answer === undefined && rows.length === 0) continue;
        const names = await this.names.byMembershipId(ctx, rows.map((l) => l.membershipId).filter((id): id is string => !!id));
        out.push({
          kode: b.kode, kind: 'downline', title, questionKodes,
          stillCoaching: answer === 'yes' ? true : answer === 'no' ? false : null,
          leaders: rows.map((l) => ({
            membershipId: l.membershipId ?? null,
            name: (l.membershipId && names.get(l.membershipId)) || '',
            areas: l.areas.map((kode) => ({ kode, label: areasQ!.items.find((i) => i.kode === kode)?.label ?? { id: kode, en: kode } })),
          })),
        });
      }
    }
    return out;
  }
}

function answerOf(response: SurveyResponseDocument, kode: string): Record<string, unknown> | undefined {
  return response.answers.find((a) => a.questionKode === kode)?.value as Record<string, unknown> | undefined;
}

/** `QUAL_PERSON_ISSUE_COUNT`: the section's answers with an issue; a unit item's consistency and comfort each count. */
export function issuesIn(section: CoachingSection, max: number): number {
  switch (section.kind) {
    case 'scale':
      return section.items.filter((i) => i.rating !== null && isIssue('rating', i.rating, max)).length;
    case 'state':
      return section.items.filter((i) => i.state !== null && isIssue('state', i.state, max)).length;
    case 'unit':
      return section.items.filter((i) => i.state !== null && isIssue('state', i.state, max)).length
        + section.items.filter((i) => i.rating !== null && isIssue('rating', i.rating, max)).length;
    default:
      return 0;
  }
}

function hidden(reason: 'session'): DomainException {
  return new DomainException(
    ErrorCode.SURVEY_ANSWERS_HIDDEN, SURVEY_REFUSALS.SURVEY_ANSWERS_HIDDEN[reason], HttpStatus.FORBIDDEN,
  );
}
