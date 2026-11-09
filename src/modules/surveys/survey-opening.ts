import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { qualItemsOf, type AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { AnalyticsConfigReader, type PublishedAnalyticsConfig } from '@/modules/config/analytics-config.reader';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { SurveyRoleClass } from '@/domain/constants';
import { SurveyParticipationRepository, SurveyRunRepository } from './survey.repositories';
import type { SurveyKind, SurveyRunDocument, SurveySnapshot } from './survey-run.schema';
import { askedQuestions } from './survey-rules';

/** The template section a kind belongs to. */
export const SECTION_OF: Record<SurveyKind, 'NPS' | 'QUAL'> = { nps: 'NPS', qual: 'QUAL' };

/** Whether the template has a kind's section on. */
export const sectionOn = (config: AdvancedAnalyticsConfig, kind: SurveyKind) =>
  config.sections.some((s) => s.kode === SECTION_OF[kind] && s.enabled);

/**
 * **What a run fixes when it opens** (R6, AT-8; ADR-0216 §2): the questions and the cut-offs of the version the KPM reads
 * at that moment, a qualitative question's items resolved (`qualItemsOf`), and which privacy line its form carries. A
 * version published afterwards never reaches the run.
 *
 * The notice (C-R8, B-R4): the NPS sentence on an anonymous run, of either kind; B-R4's on a qualitative run shown per
 * person; none otherwise.
 */
export function snapshotOf(
  run: { kind: SurveyKind; anonymous: boolean; perPerson: boolean }, published: PublishedAnalyticsConfig,
): SurveySnapshot {
  const { config } = published;
  const bands = {
    ageBandUpper: [...config.thresholds.ageBandUpper] as [number, number],
    tenureBands: [...config.thresholds.tenureBands] as [number, number, number],
  };
  const notice = run.anonymous ? 'anonymous' : run.kind === 'qual' && run.perPerson ? 'per_person' : null;
  const base = { templateId: published.templateId, configVersion: published.version, notice } as const;
  if (run.kind === 'nps') {
    return {
      ...base,
      questions: config.nps.questions.map((q) => ({ ...q, text: { ...q.text } })),
      openQuestion: { kode: 'OPEN', text: { ...config.nps.openQuestion.text } },
      blocks: [],
      cutoffs: { promoterMin: config.nps.promoterMin, passiveMin: config.nps.passiveMin, ...bands },
    };
  }
  return {
    ...base,
    questions: [],
    openQuestion: null,
    blocks: config.qualitative.blocks.map((b) => ({
      kode: b.kode,
      title: { ...b.title },
      audience: b.audience,
      questions: b.questions.map((q) => ({ kode: q.kode, text: { ...q.text }, type: q.type, items: qualItemsOf(q) })),
    })),
    cutoffs: {
      qualIssueMaxRating: config.thresholds.qualIssueMaxRating,
      supportPromMin: config.thresholds.supportPromMin,
      supportPasMin: config.thresholds.supportPasMin,
      ...bands,
    },
  };
}

/**
 * **Runs open at the first read on or after their day** (ADR-0216 §2: *"at 00:00 on `opensOn` in the KPM's zone, or at
 * the first read after it"*): the snapshot, then one `surveyParticipation` row per member of the invited classes who is
 * *Aktif* that day. Whichever read gets there first writes them; a second finds the snapshot written and writes
 * nothing. Someone who joins later is not invited.
 */
@Injectable()
export class SurveyOpening {
  constructor(
    private readonly runs: SurveyRunRepository,
    private readonly participation: SurveyParticipationRepository,
    private readonly memberships: MembershipRepository,
    private readonly config: AnalyticsConfigReader,
    private readonly clock: Clock,
  ) {}

  /**
   * Open every run of the request's KPM whose day has come.
   *
   * **Never inside a read-only session** (ADR-0206 §4, *"nothing is written"*; ADR-0207 §4): a view-as session or a
   * platform read reaches `GET /surveys`, `/surveys/pending`, `/surveys/:runId` and the results reads, and opening
   * writes a snapshot, a participation row per invited member and `invitedCount`. The KPM's own next read opens the
   * run, as it would have — the session sees the office as it stands.
   */
  async openDue(ctx: RequestContext, today: LocalDate): Promise<void> {
    if (ctx.impersonationReadOnly) return;
    const due = await this.runs.dueToOpen(ctx, today);
    if (due.length === 0) return;
    const published = await this.config.publishedFor(ctx);
    for (const run of due) await this.open(ctx, run, published);
  }

  private async open(ctx: RequestContext, run: SurveyRunDocument, published: PublishedAnalyticsConfig): Promise<void> {
    const snapshot = snapshotOf(run, published);
    const claimed = await this.runs.claimOpening(ctx, String(run._id), snapshot, this.clock.now());
    if (!claimed) return;
    const members = await this.memberships.find(
      ctx, { status: 'active', role: { $in: [...run.invitedRoleClasses] } }, { projection: { _id: 1, role: 1 } },
    );
    // Who has a leader below them today: Q10 and Q11 are theirs to answer.
    const leaders = await this.memberships.find(
      ctx, { status: 'active', role: { $in: ['aab', 'ab'] }, leaderId: { $ne: null } }, { projection: { leaderId: 1 } },
    );
    const leadsLeaders = new Set(leaders.map((m) => String(m.leaderId)));
    const rows = members.map((m) => {
      const roleClass = m.role as SurveyRoleClass;
      const asksDownline = leadsLeaders.has(String(m._id));
      return {
        membershipId: String(m._id), roleClass, asksDownline,
        totalCount: askedQuestions(run.kind, snapshot, roleClass, { downlineLeaders: asksDownline }).length,
      };
    });
    await this.participation.invite(ctx, String(run._id), rows);
    await this.runs.updateById(ctx, String(run._id), { $set: { invitedCount: rows.length } });
  }
}
