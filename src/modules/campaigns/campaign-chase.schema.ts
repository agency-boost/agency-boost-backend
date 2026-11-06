import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type CampaignChaseDocument = HydratedDocument<CampaignChase>;

/**
 * **One member's chase of one campaign** (P18.2-T7, D-lists; OD-153: chasing is enrolment).
 *
 * The prototype keeps `chased` on the shared campaign (`Overall.html:7935`), so one agent's star would be every
 * agent's. Here it is the member's own record, **keyed by the membership `_id` and the campaign's stable code**
 * (invariants §2, §4): a re-join is a new membership and starts with no chase; a campaign's code never changes, so
 * its chases keep resolving through every edit.
 *
 * **One row per (member, campaign), toggled**: `chasing` and when it last changed. Dropping a chase keeps the row
 * (`chasing: false`, `unchasedAt`), so a later standing can say whether somebody had chased; a leaver's chases are
 * closed the same way through `MemberDeparture` (`closedBy: 'departure'`). Nothing is hard-deleted (invariant §6).
 */
@Schema({ ...baseSchemaOptions, collection: 'campaignChases' })
export class CampaignChase {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** The member's membership `_id` — never a user id, never a name. */
  @Prop({ type: String, required: true })
  membershipId!: string;

  /** The campaign's stable code. */
  @Prop({ type: String, required: true })
  campaignCode!: string;

  @Prop({ type: Boolean, required: true, default: true })
  chasing!: boolean;

  @Prop({ type: Date, default: null })
  chasedAt!: Date | null;

  @Prop({ type: Date, default: null })
  unchasedAt!: Date | null;

  /** Why the last drop happened: the member's own *Stop chasing*, or their leaving the office. */
  @Prop({ type: String, enum: ['member', 'departure', null], default: null })
  closedBy!: 'member' | 'departure' | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const CampaignChaseSchema = SchemaFactory.createForClass(CampaignChase);
/** One row per member and campaign: what the toggle upserts on. */
CampaignChaseSchema.index(
  { kpmId: 1, campaignCode: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** A member's chases — the Summary card, the coachee's chips, the Unit Dashboard's roster read in bulk. */
CampaignChaseSchema.index({ kpmId: 1, membershipId: 1, chasing: 1 });
