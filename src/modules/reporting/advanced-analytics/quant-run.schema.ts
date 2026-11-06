import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import type { QuantMetric } from '@/domain/constants';
import type { QuantNullReason } from '@/domain/metrics/quant';

export type QuantRunDocument = HydratedDocument<QuantRun>;

/** One metric of a run, as stored: the value, whether every month it reads is complete, and the months it misses. */
export interface StoredQuantValue {
  value: number | null;
  complete: boolean;
  missingMonths: string[];
  reason: QuantNullReason;
}

/** The peers of one metric: a median and a count, never a peer's figure (ADR-0215 §5). */
export interface StoredPeers {
  median: number | null;
  peers: number;
}

/**
 * **`quantRuns` — one per `(kpmId, periodEnd)`** (P19.5-T3 AC-9; ADR-0215 §6; AA UI-023): a KPM's ten Quant metrics for
 * a semi-annual period, **recalculated until the 15th of the month after it, then frozen**.
 *
 * - Until `freezesAt` (00:00 on the 16th, in the KPM's calendar) every read and every write into a month the run reads
 *   recalculates `values`; the median is read live from the peers' runs.
 * - **The first read or write after `freezesAt` freezes it first**: the values and the medians (`peers`) are stored as
 *   they stand, before that write applies, and never change again.
 * - **A write into a frozen run's months** sets `lateWriteAt`: *"Data diunggah setelah periode dikunci"*.
 *
 * `companyId` is the KPM's company at computing: the peers' read (`peerMediansAcrossTenants`) reads a company's runs by
 * the company's KPM ids, `kpmId` leading the index (invariant §1).
 */
@Schema({ ...baseSchemaOptions, collection: 'quantRuns' })
export class QuantRun {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true })
  companyId!: string;

  /** `YYYY-06` or `YYYY-12`. */
  @Prop({ type: String, required: true })
  periodEnd!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  values!: Record<QuantMetric, StoredQuantValue>;

  /** Written when the run freezes; `null` while it is live. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  peers!: Record<QuantMetric, StoredPeers> | null;

  @Prop({ type: Date, required: true })
  computedAt!: Date;

  @Prop({ type: Date, required: true })
  freezesAt!: Date;

  @Prop({ type: Date, default: null })
  frozenAt!: Date | null;

  @Prop({ type: Date, default: null })
  lateWriteAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const QuantRunSchema = SchemaFactory.createForClass(QuantRun);

/** One live run per KPM and period; the peers' read walks it by the company's KPM ids. */
QuantRunSchema.index({ kpmId: 1, periodEnd: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
