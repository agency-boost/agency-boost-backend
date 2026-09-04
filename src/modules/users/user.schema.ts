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

/** Initials for the avatar chip, derived rather than stored. */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
