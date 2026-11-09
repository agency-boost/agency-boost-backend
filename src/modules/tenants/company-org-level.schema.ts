import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import type { LeaderTier } from '@/domain/constants';

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
   * **Whether this rung leads, and how** (ADR-0156): `senior` (*Senior Leader*, what AB is), `associate`
   * (*Associate Leader*, what AAB is) or `null` (*Not a leader*). A member's `role` class is derived from it
   * wherever they are placed on the rung, and RBAC, *Leaders used* and the agency and unit partitions read the
   * class — so a company whose leaders are `SM` and `UM` marks them and they lead.
   *
   * **No default, on purpose.** A row written before the field existed reads as absent, and `tierOfRung` reads
   * an absent tier as migration 0030 writes it (`AB` senior, `AAB` associate, others none). A `default: null`
   * would hydrate that row as *Not a leader* and demote every AB the moment the code ran ahead of the migration.
   *
   * **Fixed while anybody holds the rung** (`409 ORG_LEVEL_TIER_IN_USE`): nobody is re-classed silently.
   */
  @Prop({ type: String, enum: ['senior', 'associate', null] })
  leaderTier?: LeaderTier | null;

  /**
   * Archived, never deleted (invariant 3). A ladder rung that vanished would orphan every
   * membership and every history row that referenced it, and those have to keep rendering.
   */
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  /**
   * **Moves on every write of the rung** (P19-T6 AC-2; the 11-03 handover's B1-10): `PATCH /admin/org-levels/:id`
   * with an `expectedVersion` it has moved past is refused `409 VERSION_CONFLICT`, so a Super Admin acting on a
   * ladder somebody else changed since it was read is told so rather than overwriting it.
   *
   * **No `@Prop`: it is the schema's version key** (`baseSchemaOptions`, `versionKey: 'version'`), which Mongoose
   * writes as `0` when a rung is made and — this schema holding no array — never moves on its own. `OrgLevelService`
   * moves it, in the write's own filter. A rung written raw, as migration 0037 writes the Template's, has none and
   * reads as `0`; the filter matches it by the field's absence.
   */
  version?: number;

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
