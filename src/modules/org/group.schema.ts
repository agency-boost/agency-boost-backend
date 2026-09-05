import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type GroupStatus = 'active' | 'archived';

/**
 * An informal grouping the office defines for itself.
 *
 * A **tag**, never hierarchy. The prototype is explicit about it — *"just tags the KPM
 * Owner defines for their own organizing … no access logic wired up"*
 * (`KPM_Owner.html:4373-4375`) — and P3-T9 AC-1 makes it a rule: a group never
 * participates in scope resolution. Nothing in `visibleTo` may ever read this.
 *
 * It is not published configuration, so it carries no semantic `code` and no `version`:
 * nothing references a group by code, no formula binds to one, and renaming one is
 * exactly what a KPM Owner should be able to do. It is still never hard-deleted —
 * archiving keeps the tag readable on the people who carried it.
 */
@Schema({ ...baseSchemaOptions, collection: 'groups' })
export class Group {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  name!: string;

  /**
   * The membership that owns it — never a display name.
   *
   * The prototype stores `ownerName` and keys member tags by name too, which breaks the
   * moment two people share one or anybody marries. Names are mutable attributes; the
   * membership id is the foreign key (`.claude/rules/domain-invariants.md` §2).
   */
  @Prop({ type: String, required: true })
  ownerMembershipId!: string;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: GroupStatus;

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdByMembershipId!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export type GroupDocument = HydratedDocument<Group>;
export const GroupSchema = SchemaFactory.createForClass(Group);

/**
 * One live group per name per office.
 *
 * Two groups called "Top Producers 2026" are indistinguishable on a checkbox list, and
 * somebody would be tagged into the wrong one. Archived rows are exempt, so a name can
 * be reused after a group is retired.
 */
GroupSchema.index(
  { kpmId: 1, name: 1 },
  { unique: true, partialFilterExpression: { status: 'active', deletedAt: null } },
);
GroupSchema.index({ kpmId: 1, status: 1, name: 1 });
