import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type CoachingProfileDocument = HydratedDocument<CoachingProfile>;

/**
 * **A tick set a save replaced**, kept whole (`erd.md`, *`coachingProfiles`*): the version it was, the
 * codes it held, and when and by whom it was written. No screen lists it; it is the attribution a
 * profile save writes instead of an audit entry (`functional/coaching.md`, *Writes*).
 */
@Schema({ _id: false })
export class CoachingProfileRevision {
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: [String], default: [] })
  milestoneCodes!: string[];

  @Prop({ type: [String], default: [] })
  skillCodes!: string[];

  /** When that tick set was saved. */
  @Prop({ type: Date, required: true })
  at!: Date;

  /** Who saved it: a coach of the person, by membership. */
  @Prop({ type: String, required: true })
  byMembershipId!: string;
}

export const CoachingProfileRevisionSchema = SchemaFactory.createForClass(CoachingProfileRevision);

/**
 * **One coachee's capability ladder and skill tracker** (P11-T9; `erd.md`, *`coachingProfiles`*).
 *
 * One per coachee, shared by every current coach of the person, as the prototype keeps one ladder and
 * one tracker per person (`Overall.html:11189-11282`). **Each tick is a code of the office's capability
 * catalog**, never a label or a position (invariant §4, ADR-0025, ADR-0036).
 *
 * **The stage is not stored.** It is derived on every read from `milestoneCodes`
 * (`CapabilityService.stageFor`): a stored stage would drift from the ticks the first time the office
 * changed what a stage requires.
 */
@Schema({ ...configSchemaOptions, collection: 'coachingProfiles' })
export class CoachingProfile {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** The person assessed: their **membership**, never a user id or a name (invariant §2). */
  @Prop({ type: String, required: true })
  coacheeMembershipId!: string;

  /** The capability milestones ticked, by catalog code. */
  @Prop({ type: [String], default: [] })
  milestoneCodes!: string[];

  /** The skill-tracker items ticked, by catalog code, across the four grids. */
  @Prop({ type: [String], default: [] })
  skillCodes!: string[];

  /** Counts saves: the first is 1, and a profile never saved reads as 0. */
  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: [CoachingProfileRevisionSchema], default: [] })
  revisions!: CoachingProfileRevision[];

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CoachingProfileSchema = SchemaFactory.createForClass(CoachingProfile);

/**
 * **One profile per coachee**, held by the database: two coaches saving a first tick set at once write
 * one profile, and the second is `VERSION_CONFLICT`. Partial on `deletedAt: null`, so a soft-deleted
 * profile does not count. `kpmId` leads (invariant §1), and the same index serves every read.
 */
CoachingProfileSchema.index(
  { kpmId: 1, coacheeMembershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
