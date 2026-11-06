import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ConfigSnapshotDocument = HydratedDocument<ConfigSnapshot>;

/** Where a published version came from (ADR-0208 §5). */
export type ConfigSnapshotOrigin =
  | { source: 'kpm' }
  | {
    source: 'template_push';
    templateId: string;
    /** The version of each kind pushed. */
    templateVersions: Partial<Record<string, number>>;
    /** The Super Admin's user id: a platform write has no membership. */
    pushedBy: string;
    pushedAt: Date;
  }
  /**
   * ***Sinkron dari template*** (P19.6-T4, ADR-0220 §4): the KPM's Owner or an Admin took its template's names and
   * descriptions — the template, and the versions of `training_taxonomy` and `capability_ladder` read.
   */
  | {
    source: 'template_sync';
    templateId: string;
    templateVersions: Partial<Record<string, number | null>>;
  }
  /** A migration republished the KPM (P19.6-T4, ADR-0220 §3: `0059-training-title-split`), naming itself. */
  | { source: 'migration'; migration: string };

/**
 * What an office's agents are actually working against (P4-T6).
 *
 * **A published copy, not a second set of editable rows.** An Owner restructuring a
 * taxonomy does it in steps — archive three, add four, rebind two ratios — and between
 * those steps the office's live configuration is genuinely inconsistent: a ratio can name
 * a type that was archived a minute ago and nobody can log against any more. Agents would
 * see that, and their ratios would misread, for as long as the Owner took.
 *
 * So the settings screens edit rows and the agent surfaces read this. Publishing renders
 * the rows into one document; nothing else changes what agents see.
 *
 * **One document, which is also why `/kpm/config` is fast.** The read an agent makes on
 * every screen is a single `findOne` rather than three collection scans and a join in
 * application code — and the budget that has to fit is a mid-range Android over 4G.
 */
@Schema({ ...configSchemaOptions, collection: 'configSnapshots' })
export class ConfigSnapshot {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** Monotonic per office. What a client compares to know its copy is stale. */
  @Prop({ type: Number, required: true })
  version!: number;

  /**
   * The highest row `version` this was rendered from — kept for the audit record, and
   * **no longer what the publish gate compares** (P5-T11).
   *
   * It was: "if any live row is above this, something has been edited since". That misses a
   * created row (version 1), an edit below the maximum, and an archive — the gate now
   * compares which rows are present at which version, from `payload`, which every snapshot
   * already carries.
   */
  @Prop({ type: Number, required: true })
  sourceVersion!: number;

  /** The rendered configuration: taxonomy, ratios, both pipelines. */
  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Date, required: true })
  publishedAt!: Date;

  /** Membership id of whoever published it. Null for the copy provisioning writes. */
  @Prop({ type: String, default: null })
  publishedBy!: string | null;

  /**
   * **What made this version** (ADR-0208 §5): `kpm` — the office's own *Publish*; `template_push` — the Super Admin
   * applied a template's newest published sections to it, naming the template, its versions, who and when; `null` on a
   * version written before the field existed, and on provisioning's first copy, which `publishedBy: null` already says.
   */
  @Prop({ type: Object, default: null })
  origin!: ConfigSnapshotOrigin | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ConfigSnapshotSchema = SchemaFactory.createForClass(ConfigSnapshot);

/** The read every agent screen makes: this office's newest published copy. */
ConfigSnapshotSchema.index({ kpmId: 1, version: -1 });
