import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type UserDocument = HydratedDocument<User>;

/** Identity is global; participation in an office is a membership (ADR-0002). */
@Schema({ ...baseSchemaOptions, collection: 'users' })
export class User {
  /**
   * Stored lower-cased and unique. Email is case-insensitive in practice — treating
   * `Rina@x.test` and `rina@x.test` as two accounts is a support ticket, not a feature.
   */
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true, index: true })
  email!: string;

  @Prop({ type: String, default: null })
  phone!: string | null;

  /**
   * The insurer this person sells for, chosen when they register.
   *
   * A person belongs to one company (ADR-0017). It is on `users` rather than on the
   * membership because the agent code below is theirs, and they have one before any
   * office has let them in — a registered person with no membership is a state this
   * product supports and shows.
   *
   * Null only for a Super Admin, who sells for nobody.
   */
  @Prop({ type: String, default: null, index: true })
  companyId!: string | null;

  /**
   * The producer id the insurer issued them — their identifier alongside their email.
   *
   * **Unique within the company, not globally** (ADR-0017). Two insurers may issue the
   * same string to different people, and their numbering rules are their own. Stored
   * upper-cased and trimmed, because it is read off a contract and typed by hand.
   *
   * Immutable once set: it is the join key the monthly production import matches on, so
   * changing one silently breaks the attribution of every row already imported under the
   * old value.
   */
  @Prop({ type: String, default: null, uppercase: true, trim: true })
  agentCode!: string | null;

  @Prop({ type: String, required: true, select: false })
  passwordHash!: string;

  @Prop({ type: String, required: true, trim: true })
  fullName!: string;

  @Prop({ type: String, default: null })
  preferredName!: string | null;

  /**
   * Defaults to `they`. A name does not tell you someone's pronouns, and the coaching
   * commitment sentence interpolates this — a wrong guess misgenders a real person on
   * a screen their leader reads.
   */
  @Prop({ type: String, enum: ['she', 'he', 'they'], default: 'they' })
  pronoun!: 'she' | 'he' | 'they';

  @Prop({ type: String, default: null })
  avatarUrl!: string | null;

  @Prop({ type: String, default: null })
  locale!: string | null;

  @Prop({ type: String, default: null })
  timezone!: string | null;

  @Prop({ type: String, enum: ['super_admin', 'none'], default: 'none', index: true })
  platformRole!: 'super_admin' | 'none';

  @Prop({ type: String, enum: ['invited', 'active', 'deactivated'], default: 'invited', index: true })
  status!: 'invited' | 'active' | 'deactivated';

  @Prop({ type: Date, default: null })
  emailVerifiedAt!: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

/**
 * Unique per company, over live rows only.
 *
 * `partialFilterExpression` does two jobs. It excludes soft-deleted rows, so erasing an
 * account releases its code. And it excludes the `(null, null)` pair every Super Admin
 * carries — a plain compound unique index would admit exactly one of them and refuse the
 * second operator, which is a state the seed creates deliberately.
 */
UserSchema.index(
  { companyId: 1, agentCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      companyId: { $type: 'string' },
      agentCode: { $type: 'string' },
    },
  },
);

/** Initials for the avatar chip, derived rather than stored. */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
