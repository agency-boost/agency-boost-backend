import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type CompanyOrgLevelDocument = HydratedDocument<CompanyOrgLevel>;

/**
 * A rung on a company's role ladder — `Agent → AAB → AB` in Prudential's.
 *
 * **Owned by the company, not the office** (ADR-0012). A KPM cannot invent a rung, rename
 * one or remove one, because an office is a branch of a company and the ladder is what the
 * company promotes people along. Only Super Admin writes here.
 *
 * **Referenced by `code`, never by position.** The client's PRD models a ladder as
 * `{level_order, label}`, and that shape corrupts the moment somebody inserts a level
 * between AAB and AB — every `level_order` below it shifts, and every row that stored one
 * now points at a different rung. Their own prototype depicts exactly that insertion.
 * ADR-0006 is the standing rule; `displayOrder` here is presentation and is reorderable,
 * `code` is the identity and is not.
 */
@Schema({ ...baseSchemaOptions, collection: 'companyOrgLevels' })
export class CompanyOrgLevel {
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  /**
   * Stable and semantic: `AGENT`, `AAB`, `AB`. Never changes once published, and never
   * reused — an archived level keeps its code, or a historical membership pointing at it
   * would silently come to mean a different rung.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  /** What a reader sees. Free to change; the code underneath does not. */
  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Junior first: Agent is 1, AB is last. Reorderable, which is why nothing references it. */
  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /**
   * Archived, never deleted (invariant 3). A ladder rung that vanished would orphan every
   * membership and every history row that referenced it, and those have to keep rendering.
   */
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const CompanyOrgLevelSchema = SchemaFactory.createForClass(CompanyOrgLevel);

/**
 * One code per company, counting **archived levels too**. Uniqueness among the merely
 * active would let a retired `AAB` be recreated as something else, and every membership
 * that still points at the old one would quietly change meaning.
 */
CompanyOrgLevelSchema.index(
  { companyId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The read order: a company's ladder, junior first. */
CompanyOrgLevelSchema.index({ companyId: 1, displayOrder: 1 });
