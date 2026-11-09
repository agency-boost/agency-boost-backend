import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import type { LocalDate } from '@/common/time/local-day';
import {
  SurveyParticipation, type SurveyParticipationDocument, type ReminderMoment,
} from './survey-participation.schema';
import { SurveyResponse, type SurveyAnswer, type SurveyResponseDocument } from './survey-response.schema';
import { SurveyRun, type SurveyKind, type SurveyRunDocument, type SurveySnapshot } from './survey-run.schema';

/**
 * **A KPM's survey runs, behind the chokepoint** (invariant §1). One named unscoped read, for the template's *Bagian*
 * switch: how many runs are open in a template's KPMs (AA UI-022, AT-12) — counts, never a row.
 */
@Injectable()
export class SurveyRunRepository extends TenantScopedRepository<SurveyRunDocument> {
  constructor(@InjectModel(SurveyRun.name) model: Model<SurveyRunDocument>) {
    super(model, 'surveyRuns');
  }

  /** The KPM's live runs, newest period first. */
  async list(ctx: RequestContext, kind?: SurveyKind): Promise<SurveyRunDocument[]> {
    return this.find(ctx, kind ? { kind } : {}, { sort: { opensOn: -1, _id: -1 } });
  }

  /** Runs whose day has come and that have not taken their snapshot. */
  async dueToOpen(ctx: RequestContext, today: LocalDate): Promise<SurveyRunDocument[]> {
    return this.find(ctx, { snapshot: null, opensOn: { $lte: today } });
  }

  /** **Claim a run's opening**: the snapshot written once, by whichever read gets there first. `null` if another did. */
  async claimOpening(ctx: RequestContext, runId: string, snapshot: SurveySnapshot, at: Date): Promise<SurveyRunDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'claimOpening', { _id: runId, snapshot: null } as FilterQuery<SurveyRunDocument>),
      { $set: { snapshot, openedAt: at } },
      { new: true },
    ).exec();
  }

  /**
   * **How many runs of `kind` are open on each office's today, in the offices named, by a Super Admin who is in none**
   * (ADR-0214 §1, ADR-0216 §2; `named-cross-tenant-reads.tenancy.spec.ts`). Counts only: the runs, and the offices.
   */
  async countOpenInOfficesAcrossTenants(
    ctx: RequestContext, todayByOffice: ReadonlyMap<string, LocalDate>, kind: SurveyKind,
  ): Promise<{ runs: number; kpms: number }> {
    if (!ctx.isSuperAdmin) throw new MissingTenantContextError(this.collectionName, 'countOpenInOfficesAcrossTenants');
    if (todayByOffice.size === 0) return { runs: 0, kpms: 0 };
    const or = [...todayByOffice].map(([kpmId, today]) => ({ kpmId, opensOn: { $lte: today }, closesOn: { $gte: today } }));
    const rows = await this.model.find({ $or: or, kind, deletedAt: null }, { kpmId: 1 }).lean().exec();
    return { runs: rows.length, kpms: new Set(rows.map((r) => r.kpmId)).size };
  }
}

/** Who was invited to which run, and how far they got (ADR-0216 §3). */
@Injectable()
export class SurveyParticipationRepository extends TenantScopedRepository<SurveyParticipationDocument> {
  constructor(@InjectModel(SurveyParticipation.name) model: Model<SurveyParticipationDocument>) {
    super(model, 'surveyParticipation');
  }

  /** **The invitations of a run's opening**, once each: a second opening's rows are already there and are left be. */
  async invite(
    ctx: RequestContext, runId: string,
    rows: readonly { membershipId: string; roleClass: SurveyParticipation['roleClass']; totalCount: number; asksDownline: boolean }[],
  ): Promise<void> {
    for (const row of rows) {
      await this.upsertOne(ctx, { runId, membershipId: row.membershipId }, {
        $setOnInsert: {
          roleClass: row.roleClass, totalCount: row.totalCount, asksDownline: row.asksDownline, answeredCount: 0, lastQuestionKode: null,
          draftAnswers: null, submittedAt: null, reminder: { lastPopupOn: null, momentsShown: [] },
        },
      });
    }
  }

  /** The reader's own invitations, over the runs named. */
  async mine(ctx: RequestContext, runIds?: readonly string[]): Promise<SurveyParticipationDocument[]> {
    return this.find(ctx, { membershipId: ctx.membershipId, ...(runIds ? { runId: { $in: [...runIds] } } : {}) });
  }

  /** One member's invitation to one run, or `null`. */
  async of(ctx: RequestContext, runId: string, membershipId: string): Promise<SurveyParticipationDocument | null> {
    return this.findOne(ctx, { runId, membershipId });
  }

  /** A run's invitations. */
  async ofRun(ctx: RequestContext, runId: string): Promise<SurveyParticipationDocument[]> {
    return this.find(ctx, { runId });
  }

  /** One answer saved, while the form is not sent: the draft, the count and where the respondent got to. */
  async saveDraft(
    ctx: RequestContext, id: string, draft: Record<string, unknown>, answeredCount: number, lastQuestionKode: string,
  ): Promise<SurveyParticipationDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'saveDraft', { _id: id, submittedAt: null } as FilterQuery<SurveyParticipationDocument>),
      { $set: { draftAnswers: draft, answeredCount, lastQuestionKode, updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /**
   * **The form sent**: `submittedAt`, and the draft set to `null` — a field cleared, no row deleted — once, whoever
   * gets there first; `null` when it had been sent already.
   */
  async markSubmitted(ctx: RequestContext, id: string, at: Date, answeredCount: number): Promise<SurveyParticipationDocument | null> {
    return this.model.findOneAndUpdate(
      this.scope(ctx, 'markSubmitted', { _id: id, submittedAt: null } as FilterQuery<SurveyParticipationDocument>),
      { $set: { submittedAt: at, draftAnswers: null, answeredCount, updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }

  /** A popup shown today (C-R3, C-R4): the day, and the moments it covers, on each of the reader's runs named. */
  async popupShown(ctx: RequestContext, runIds: readonly string[], today: LocalDate, moments: readonly ReminderMoment[]): Promise<number> {
    return this.updateMany(
      ctx,
      { membershipId: ctx.membershipId, runId: { $in: [...runIds] }, submittedAt: null },
      { $set: { 'reminder.lastPopupOn': today }, $addToSet: { 'reminder.momentsShown': { $each: [...moments] } } },
    );
  }
}

/**
 * **The sent forms** (ADR-0216 §3). An anonymous one is written by `insertAnonymous`, which leaves every trace of its
 * author off the row: no `membershipId`, no `submittedAt`, `createdBy` `null`, and an `_id` of random bytes.
 */
@Injectable()
export class SurveyResponseRepository extends TenantScopedRepository<SurveyResponseDocument> {
  constructor(@InjectModel(SurveyResponse.name) model: Model<SurveyResponseDocument>) {
    super(model, 'surveyResponses');
  }

  /** **An anonymous run's form**: no person on it anywhere (ADR-0216 §3). */
  async insertAnonymous(
    ctx: RequestContext,
    row: { runId: string; answers: SurveyAnswer[]; roleClass: SurveyResponse['roleClass']; tenureBand: number | null; ageBand: number | null },
  ): Promise<void> {
    const kpmId = this.scope(ctx, 'insertAnonymous').kpmId as string;
    await this.model.create({
      // Twelve random bytes: an ObjectId's first four are the second it was made.
      _id: new Types.ObjectId(randomBytes(12).toString('hex')),
      kpmId, runId: row.runId, membershipId: null, submittedAt: null, answers: row.answers,
      roleClass: row.roleClass, tenureBand: row.tenureBand, ageBand: row.ageBand, noticeShown: false,
      deletedAt: null, createdBy: null, updatedBy: null,
    });
  }

  /** **A named run's form**: the respondent's membership and when it was sent (ADR-0216 §3). */
  async insertNamed(
    ctx: RequestContext,
    row: {
      runId: string; answers: SurveyAnswer[]; roleClass: SurveyResponse['roleClass']; tenureBand: number | null;
      ageBand: number | null; submittedAt: Date; noticeShown: boolean;
    },
  ): Promise<void> {
    await this.create(ctx, { ...row, membershipId: ctx.membershipId } as Partial<SurveyResponseDocument>);
  }

  async ofRun(ctx: RequestContext, runId: string): Promise<SurveyResponseDocument[]> {
    return this.find(ctx, { runId }, { sort: { _id: 1 } });
  }

  /** One person's form for one run, where the run kept who sent it. */
  async ofPerson(ctx: RequestContext, runId: string, membershipId: string): Promise<SurveyResponseDocument | null> {
    return this.findOne(ctx, { runId, membershipId });
  }
}
