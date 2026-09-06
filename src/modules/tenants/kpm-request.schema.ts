import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type KpmRequestStatus = 'pending' | 'approved' | 'declined';

/**
 * Somebody asking for an office that does not exist yet.
 *
 * `Superadmin.html:322-333` shows the queue — `KPM name` · `Company` · `Requested by` ·
 * `Status`, each row naming a person **and their intent**: *"Rangga Wibisono (proposed
 * KPM Owner)"*. ADR-0011 records it as the one genuinely new flow the prototype defines:
 * in our model an office is created *by* a Super Admin, and nobody could ask for one.
 *
 * **Platform-global, and deliberately so.** A request is for a tenant that does not
 * exist, so it cannot carry a `kpmId` — there is nothing to scope it to until it is
 * approved, at which point `createdKpmId` names what it became. It is classified
 * `EXEMPT` in the index convention for that reason, with the same reason written there.
 *
 * **The requester is the proposed Owner.** The prototype conflates them and it is right
 * to: somebody asking for an office is asking to run one. Held as a `userId` because
 * identity is global and there is no membership to point at — the membership is created
 * on approval, by the office the approval creates.
 */
@Schema({ ...baseSchemaOptions, collection: 'kpmRequests' })
export class KpmRequest {
  /** The insurer the office would belong to. Chosen by the requester from what exists. */
  @Prop({ type: String, required: true, index: true })
  companyId!: string;

  /**
   * What the requester calls the branch — *"Surabaya Branch"*.
   *
   * Not a code. The KPM code is issued by the platform on approval, because it must be
   * unique within the company and a requester cannot know what is free.
   */
  @Prop({ type: String, required: true, trim: true, maxlength: 120 })
  branchName!: string;

  @Prop({ type: String, required: true })
  requestedByUserId!: string;

  /** Why they want one. Free text, read by whoever decides. */
  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  note!: string | null;

  @Prop({ type: String, enum: ['pending', 'approved', 'declined'], default: 'pending', index: true })
  status!: KpmRequestStatus;

  @Prop({ type: Date, default: null })
  decidedAt!: Date | null;

  @Prop({ type: String, default: null })
  decidedByUserId!: string | null;

  /** Why it was declined. Kept, because a refusal with nothing to act on is not an answer. */
  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  reason!: string | null;

  /** What it became. Null until approved, and the only link back to the office. */
  @Prop({ type: String, default: null })
  createdKpmId!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export type KpmRequestDocument = HydratedDocument<KpmRequest>;
export const KpmRequestSchema = SchemaFactory.createForClass(KpmRequest);

/**
 * One open request per person.
 *
 * Somebody with two pending asks would have two offices created for them by two separate
 * approvals, and only one of those is what they meant. Scoped to `pending` so a declined
 * request does not block a second, better-argued one.
 */
KpmRequestSchema.index(
  { requestedByUserId: 1 },
  {
    // Named, because Mongoose derives `requestedByUserId_1` for both this and the
    // history lookup below, and a partial unique index cannot share a name with a plain
    // one. The collision only surfaces when indexes are actually built.
    name: 'one_open_request_per_user',
    unique: true,
    partialFilterExpression: { status: 'pending', deletedAt: null },
  },
);
/** What one person has asked for, newest first — `mine()`. */
KpmRequestSchema.index({ requestedByUserId: 1, createdAt: -1 });
/** The queue, newest first. */
KpmRequestSchema.index({ status: 1, createdAt: -1 });
