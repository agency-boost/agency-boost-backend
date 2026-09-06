import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type InviteCodeDocument = HydratedDocument<InviteCode>;

/**
 * One invite, three presentations.
 *
 * The prototype offers a link, a leader code and a QR as if they were three things
 * (`Overall.html:3578-3596`); its own copy says otherwise — *"any of the three registers
 * your KPM and tags you to them in one step"*. So there is one record. The link carries
 * the code in a query string and the QR encodes the link; revoking the code kills all
 * three at once, which is what a leader means when they revoke.
 *
 * This path **skips approval by design**, which is exactly why every field below exists:
 * a credential that tags a stranger to your unit without you seeing it needs a lifetime,
 * a ceiling and an off switch.
 */
@Schema({ ...baseSchemaOptions, collection: 'inviteCodes' })
export class InviteCode {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /**
   * Short enough to read down a phone line, and case-insensitively unique within the
   * office. Stored upper-case; lookups upper-case what they are given, so `jor417` and
   * `JOR417` are the same code rather than one of them being a mystery.
   */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  /** Whose unit a joiner lands in. The invite is theirs, not the office's. */
  @Prop({ type: String, required: true, index: true })
  issuedByMembershipId!: string;

  /**
   * True for every invite today, and named rather than assumed.
   *
   * The whole point of this path is that it bypasses the approval inbox — the ERD calls
   * it out, and Flow C is explicit. Storing it makes that a property of the artefact
   * instead of a fact you have to know, and leaves room for an invite that does queue.
   */
  @Prop({ type: Boolean, default: true })
  autoApprove!: boolean;

  /** Null means no ceiling. A leader's standing code is normally uncapped. */
  @Prop({ type: Number, default: null })
  maxUses!: number | null;

  @Prop({ type: Number, default: 0 })
  useCount!: number;

  /** Null means it does not expire on its own. Revoking is then the only way to end it. */
  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  revokedByMembershipId!: string | null;

  /** A note for the issuer — "hiring push, September" — never shown to a joiner. */
  @Prop({ type: String, default: null })
  label!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const InviteCodeSchema = SchemaFactory.createForClass(InviteCode);

/**
 * Unique **globally**, across every office.
 *
 * This said the opposite until 2026-09-06 — *"two offices may both have a `JOR417`, and
 * a code is only ever resolved together with the office it came from"* — and the second
 * half was never true. A code is the credential somebody presents *before* they belong
 * anywhere: `InviteService.resolve` looks it up by code alone, because a joiner has no
 * office to scope the lookup to. It is the code that names the office, not the reverse.
 *
 * So with per-office uniqueness two live `JOR417`s could exist and `findOne` would return
 * whichever the plan reached first — putting the joiner in a stranger's office, under a
 * stranger's leader, with a valid-looking membership. 32^6 is a billion codes; the
 * generator retries on collision and this index is what makes that retry mean something.
 *
 * Scoped to live rows, so a soft-deleted invite releases its code for reuse.
 */
InviteCodeSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The office's own invites, and the per-office lookup behind the codes list. */
InviteCodeSchema.index({ kpmId: 1, code: 1 });
/** A leader's own invites, newest first. */
InviteCodeSchema.index({ kpmId: 1, issuedByMembershipId: 1, createdAt: -1 });
