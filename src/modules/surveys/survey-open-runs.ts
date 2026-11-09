import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { localDayOf, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { OpenSurveyRuns, type OpenRunCounts } from '@/modules/config/open-survey-runs.port';
import { Kpm, type KpmDocument } from '@/modules/tenants/kpm.schema';
import { SurveyRunRepository } from './survey.repositories';

/**
 * **The runs open now in a template's KPMs** (P19.5-T4, AC-13; AA UI-022, AT-12; ADR-0216 §2): the real `OpenSurveyRuns`,
 * replacing T1's `NoSurveyRunsYet`. Each KPM's own today, by its own zone (invariant §9), then one named count across
 * the KPMs named — runs and KPMs, never a row.
 */
@Injectable()
export class SurveyOpenRuns extends OpenSurveyRuns {
  constructor(
    private readonly runs: SurveyRunRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly clock: Clock,
  ) {
    super();
  }

  async openIn(ctx: RequestContext, kpmIds: readonly string[], kind: 'nps' | 'qual'): Promise<OpenRunCounts> {
    if (kpmIds.length === 0) return { runs: 0, kpms: 0 };
    const offices = await this.kpms.find({ _id: { $in: [...kpmIds] } }, { timezone: 1 }).lean().exec();
    const now = this.clock.now();
    const today = new Map<string, LocalDate>(
      offices.map((o) => [String(o._id), localDayOf(now, (o as { timezone?: string }).timezone ?? DEFAULT_TENANT_TIMEZONE)]),
    );
    return this.runs.countOpenInOfficesAcrossTenants(ctx, today, kind);
  }
}
