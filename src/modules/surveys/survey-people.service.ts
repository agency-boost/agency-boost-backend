import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { canOpenMember } from '@/common/auth/office-steward';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { LocalDate } from '@/common/time/local-day';
import type { SurveyRoleClass, WorkStatus } from '@/domain/constants';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import type { LabelPair } from '@/modules/config/analytics-config';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { OfficeGroups } from '@/modules/reporting/office-groups';
import { User, type UserDocument } from '@/modules/users/user.schema';
import type { SurveyResponseDocument } from './survey-response.schema';
import type { SurveyRunDocument } from './survey-run.schema';
import { SurveyOffice } from './survey-office';
import { SurveyOpening } from './survey-opening';
import {
  downlineIdsOf, issueTilesOf, personAspiration, personSections, personSupport, type PersonSection,
} from './survey-person';
import type { ResultsAudience } from './survey-results';
import { audienceOf } from './survey-runs.service';
import { bandOf, isLeaderClass, runState, wholeYears, type RunState } from './survey-rules';
import { SurveyParticipationRepository, SurveyResponseRepository, SurveyRunRepository } from './survey.repositories';
import { SURVEY_REFUSALS } from './surveys.messages';

/** One row of *Per orang*: the person, their profile facts, and whether — and how badly — they answered. */
export interface SurveyPersonRow {
  membershipId: string;
  name: string;
  photoUrl: string | null;
  roleClass: SurveyRoleClass;
  /** *Upline*: who they report to, by name; `null` at the top. */
  upline: string | null;
  /** Their informal group — an AB's own, an AAB's and an agent's their AB's (ADR-0270 §1); `null` *Tanpa group*. */
  groupId: string | null;
  workStatus: WorkStatus | null;
  tenureYears: number | null;
  age: number | null;
  /** `0` *Gen Z* to `2` *Gen X*, on the run's own bands. */
  generation: number | null;
  answered: boolean;
  /** *n item* bermasalah (`QUAL_PERSON_ISSUE_ITEMS`); `null` unanswered or where answers are not shown. */
  issues: number | null;
  /** Their answers open under the row: answered, the run shows answers per person, and the reader reaches them. */
  canOpen: boolean;
  /** For *Belum menjawab*'s WhatsApp; `null` with none or answered. */
  phone: string | null;
}

export interface SurveyPeopleView {
  today: LocalDate;
  audience: ResultsAudience;
  /** The qualitative runs that have opened, newest first: the month picker. */
  runs: { runId: string; periodKey: string; state: RunState }[];
  run: { runId: string; periodKey: string; state: RunState; anonymous: boolean; perPerson: boolean } | null;
  /** The run kept each person's answers and told them so (named, *per orang*): rows can open. */
  answersShown: boolean;
  groups: { groupId: string; name: string }[];
  issueMaxRating: number | null;
  /** Every invitee still in the KPM, test accounts never; `null` for a summary, which shows no name. */
  people: SurveyPersonRow[] | null;
}

/** One person's full answers, opened under their row (P19.22-T7 AC-3). */
export interface SurveyPersonAnswers {
  membershipId: string;
  runId: string;
  roleClass: SurveyRoleClass;
  person: { workStatus: WorkStatus | null; tenureYears: number | null; age: number | null; generation: number | null };
  issueMaxRating: number;
  /** *Item bermasalah*: per card, *x/y*. */
  tiles: { kode: string; title: LabelPair; count: number; of: number }[];
  aspiration: ReturnType<typeof personAspiration>;
  sections: PersonSection[];
  /** Q12's score — the `office` audience's alone; `null` for a core leader, who may be the leader it rates. */
  support: { kode: string; score: number | null } | null;
}

/**
 * ***Analisa kualitatif › Per orang*** (P19.22-T7 AC-3; ADR-0276 §5, amending ADR-0216 §3): every invitee of one
 * qualitative run — photo, name, role, upline, *waktu*, *masa kerja*, *usia*, *n item* bermasalah or *Belum menjawab* —
 * and, on tap, one person's full answers.
 *
 * **Who reads a person's answers** (ADR-0276 §5): the run must be named and *per orang* — an anonymous run keeps no
 * person, and its rows never open; the reader a steward — the Super Admin inside the KPM, the Owner and an Admin
 * anybody, **a core leader only their own downline** (`canOpenMember`, as People reads it), and never Q12. A view-as
 * session or a platform read sees no name here at all (`people: null`), and is refused a person's answers with
 * `403 SURVEY_ANSWERS_HIDDEN`, as the coaching tab refuses it. Anybody else of the KPM is `404`, as the tab answers them.
 * Opening a person writes the §3.5 subject read, surface `survey`.
 */
@Injectable()
export class SurveyPeopleService {
  constructor(
    private readonly runs: SurveyRunRepository,
    private readonly participation: SurveyParticipationRepository,
    private readonly responses: SurveyResponseRepository,
    private readonly opening: SurveyOpening,
    private readonly office: SurveyOffice,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly groups: OfficeGroups,
    private readonly subjectReads: SubjectReadAudit,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /** **`GET /kpm/advanced-analytics/qual/people`** — the run named, else the newest that has opened. */
  async people(ctx: RequestContext, runId?: string): Promise<SurveyPeopleView> {
    const audience = audienceOf(ctx);
    const office = await this.office.of(ctx);
    if (!ctx.isPlatformRead) await this.opening.openDue(ctx, office.today);
    const opened = (await this.runs.list(ctx, 'qual')).filter((r) => r.snapshot);
    const run = runId ? opened.find((r) => String(r._id) === runId) : opened[0];
    if (runId && !run) throw new NotFoundException('Survey run');
    const partition = await this.groups.partition(ctx);
    const base = {
      today: office.today,
      audience,
      runs: opened.map((r) => ({ runId: String(r._id), periodKey: r.periodKey, state: runState(r, office.today) })),
      groups: partition.groups.map((g) => ({ groupId: g.groupId, name: g.name })),
    };
    if (!run) return { ...base, run: null, answersShown: false, issueMaxRating: null, people: audience === 'summary' ? null : [] };
    const answersShown = shownPerPerson(run);
    const runView = {
      runId: String(run._id), periodKey: run.periodKey, state: runState(run, office.today), anonymous: run.anonymous,
      perPerson: run.perPerson,
    };
    const max = run.snapshot!.cutoffs.qualIssueMaxRating!;
    if (audience === 'summary') return { ...base, run: runView, answersShown, issueMaxRating: max, people: null };

    // The invitees still counted in the KPM — the partition holds every active member but a test account.
    const parts = (await this.participation.ofRun(ctx, String(run._id))).filter((p) => partition.members.has(p.membershipId));
    const ids = parts.map((p) => p.membershipId);
    const rows = await this.memberships.find(
      ctx, { _id: { $in: ids } }, { projection: { userId: 1, leaderId: 1, ancestorIds: 1, joinDate: 1, workStatus: 1 } },
    );
    const byId = new Map(rows.map((m) => [String(m._id), m]));
    const leaders = [...new Set(rows.map((m) => m.leaderId).filter((id): id is string => !!id))];
    const people = await this.names.pictured(ctx, [...ids, ...leaders], ids, { phones: true });
    const births = await this.birthDates(rows.map((m) => m.userId).filter((id): id is string => !!id));
    const forms = answersShown ? await this.responses.ofRun(ctx, String(run._id)) : [];
    const formOf = new Map(forms.filter((f) => f.membershipId && f.noticeShown).map((f) => [f.membershipId!, f]));
    const blocks = run.snapshot!.blocks;
    const groupOf = (id: string) => {
      const ab = partition.placement.abOf.get(id) ?? null;
      return ab === null ? null : partition.placement.groupOfAb.get(ab) ?? null;
    };

    const list = parts.map((p): SurveyPersonRow => {
      const m = byId.get(p.membershipId);
      const person = people.get(p.membershipId);
      const dob = m?.userId ? births.get(String(m.userId)) ?? null : null;
      const age = dob ? wholeYears(dob, office.today) : null;
      const form = formOf.get(p.membershipId);
      const asked = blocks.filter((b) => b.audience === 'all' || isLeaderClass(p.roleClass));
      const issues = form
        ? issueTilesOf(personSections(asked, form, office, new Map()), max).reduce((sum, t) => sum + t.count, 0)
        : null;
      const answered = p.submittedAt !== null;
      return {
        membershipId: p.membershipId,
        name: person?.name ?? '',
        photoUrl: person?.photoUrl ?? null,
        roleClass: p.roleClass,
        upline: m?.leaderId ? people.get(m.leaderId)?.name ?? null : null,
        groupId: groupOf(p.membershipId),
        workStatus: m?.workStatus ?? null,
        tenureYears: m?.joinDate ? wholeYears(m.joinDate, office.today) : null,
        age,
        generation: age === null ? null : bandOf(age, run.snapshot!.cutoffs.ageBandUpper),
        answered,
        issues: answered ? issues : null,
        canOpen: answered && form !== undefined && !ctx.isImpersonating
          && canOpenMember(ctx, { membershipId: p.membershipId, ancestorIds: m?.ancestorIds ?? [] }),
        phone: answered ? null : person?.phone ?? null,
      };
    }).filter((r) => r.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
    return { ...base, run: runView, answersShown, issueMaxRating: max, people: list };
  }

  /** **`GET /kpm/advanced-analytics/qual/people/:membershipId`** — one person's answers to the run, opened under the row. */
  async person(ctx: RequestContext, membershipId: string, runId?: string): Promise<SurveyPersonAnswers> {
    const audience = audienceOf(ctx);
    if (audience === 'summary') throw hidden();
    const office = await this.office.of(ctx);
    await this.opening.openDue(ctx, office.today);
    const member = await this.memberships.findById(ctx, membershipId);
    // Another KPM's person, nobody, or one outside a core leader's downline: one answer (ADR-0276 §5).
    if (!member || !canOpenMember(ctx, { membershipId: String(member._id), ancestorIds: member.ancestorIds ?? [] })) {
      throw new NotFoundException('Membership');
    }
    const run = await this.runOf(ctx, runId);
    const part = await this.participation.of(ctx, String(run._id), membershipId);
    const form = part?.submittedAt && shownPerPerson(run)
      ? await this.responses.ofPerson(ctx, String(run._id), membershipId)
      : null;
    if (!part || !form || !form.noticeShown) throw new NotFoundException('Membership');
    await this.subjectReads.record(ctx, { membershipId }, 'survey', { from: run.opensOn, to: run.closesOn });
    return this.answersOf(ctx, run, form, part.roleClass, member, office, audience);
  }

  // ------------------------------------------------------------------------------------------------------ parts

  private async runOf(ctx: RequestContext, runId?: string): Promise<SurveyRunDocument> {
    const opened = (await this.runs.list(ctx, 'qual')).filter((r) => r.snapshot);
    const run = runId ? opened.find((r) => String(r._id) === runId) : opened[0];
    if (!run) throw new NotFoundException('Survey run');
    return run;
  }

  private async answersOf(
    ctx: RequestContext, run: SurveyRunDocument, form: SurveyResponseDocument, roleClass: SurveyRoleClass,
    member: { userId?: string | null; workStatus?: WorkStatus | null; joinDate?: string | null },
    office: Awaited<ReturnType<SurveyOffice['of']>>, audience: ResultsAudience,
  ): Promise<SurveyPersonAnswers> {
    const snapshot = run.snapshot!;
    const blocks = snapshot.blocks.filter((b) => b.audience === 'all' || isLeaderClass(roleClass));
    const max = snapshot.cutoffs.qualIssueMaxRating!;
    const names = await this.names.byMembershipId(ctx, downlineIdsOf(blocks, form));
    const sections = personSections(blocks, form, office, names);
    const dob = member.userId ? (await this.birthDates([String(member.userId)])).get(String(member.userId)) ?? null : null;
    const age = dob ? wholeYears(dob, office.today) : null;
    return {
      membershipId: String(form.membershipId),
      runId: String(run._id),
      roleClass,
      person: {
        workStatus: member.workStatus ?? null,
        tenureYears: member.joinDate ? wholeYears(member.joinDate, office.today) : null,
        age,
        generation: age === null ? null : bandOf(age, snapshot.cutoffs.ageBandUpper),
      },
      issueMaxRating: max,
      tiles: issueTilesOf(sections, max),
      aspiration: personAspiration(blocks, form, office),
      sections,
      support: audience === 'office' ? personSupport(blocks, form) : null,
    };
  }

  /** Birth dates by user id, from the global users — the ids read through this KPM's memberships. */
  private async birthDates(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const users = await this.users.find({ _id: { $in: [...new Set(userIds)] } }, { dateOfBirth: 1 }).lean().exec();
    return new Map(users
      .filter((u) => typeof (u as { dateOfBirth?: string | null }).dateOfBirth === 'string')
      .map((u) => [String(u._id), (u as { dateOfBirth: string }).dateOfBirth]));
  }
}

/** A run that kept each person's answers and said so: named and *per orang* (B-R2). */
export function shownPerPerson(run: Pick<SurveyRunDocument, 'anonymous' | 'perPerson'>): boolean {
  return !run.anonymous && run.perPerson;
}

function hidden(): DomainException {
  return new DomainException(ErrorCode.SURVEY_ANSWERS_HIDDEN, SURVEY_REFUSALS.SURVEY_ANSWERS_HIDDEN.session, HttpStatus.FORBIDDEN);
}
