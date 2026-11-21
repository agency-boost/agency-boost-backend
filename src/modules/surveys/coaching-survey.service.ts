import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import type { SurveyRoleClass } from '@/domain/constants';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import type { LabelPair } from '@/modules/config/analytics-config';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { scopeFor } from '@/modules/rbac/permissions';
import { User, type UserDocument } from '@/modules/users/user.schema';
import type { SurveyResponseDocument } from './survey-response.schema';
import type { SnapshotQualBlock, SurveyRunDocument } from './survey-run.schema';
import { SurveyOffice } from './survey-office';
import { downlineIdsOf, issuesIn, personAspiration, personSections, type PersonSection } from './survey-person';
import { SurveyOpening } from './survey-opening';
import { bandOf, isLeaderClass, runState, wholeYears } from './survey-rules';
import { SurveyParticipationRepository, SurveyResponseRepository, SurveyRunRepository } from './survey.repositories';
import { SURVEY_REFUSALS } from './surveys.messages';

/** One section card of the tab, as the mockup draws it (B2) — `survey-person.ts`', shared with *Per orang*. */
export type CoachingSection = PersonSection;

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
      aspiration: personAspiration(blocks, response, office),
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

  /** The cards, one per block (`personSections`), Q11's downline leaders named in one read. */
  private async sections(
    ctx: RequestContext, blocks: readonly SnapshotQualBlock[], response: SurveyResponseDocument,
    office: { company: string; kpm: string },
  ): Promise<CoachingSection[]> {
    const names = await this.names.byMembershipId(ctx, downlineIdsOf(blocks, response));
    return personSections(blocks, response, office, names);
  }
}

/** `QUAL_PERSON_ISSUE_COUNT` (`survey-person.ts`), re-exported for this module's importers. */
export { issuesIn } from './survey-person';

function hidden(reason: 'session'): DomainException {
  return new DomainException(
    ErrorCode.SURVEY_ANSWERS_HIDDEN, SURVEY_REFUSALS.SURVEY_ANSWERS_HIDDEN[reason], HttpStatus.FORBIDDEN,
  );
}
