import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import {
  GENDERS, LANGUAGES, WORK_STATUSES, type Gender, type Language, type WorkStatus,
} from '@/domain/constants';

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
   *
   * **Digits only on every new write since ADR-0158 §4** (`AGENT_CODE_PATTERN`, 3 to 32 of
   * them): registration and the roster import refuse anything else. A code written before
   * keeps its letters — nothing here checks the shape, so nothing old is refused.
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

  /*
   * **What a person records about themselves** (ADR-0158, P18.8-T4): the three facts that are theirs
   * and the same in every office, beside the agent code. Required by the roster import and by
   * registration; **optional here**, because everybody who arrived before them has none, and is not
   * refused anything for it — they complete them on `/profile`. A screen reads a missing one as
   * *Not recorded*.
   *
   * Personal data under UU 27/2022 (`security-and-privacy.md`): shown to the person, the Owner and the
   * Admins, and nobody else; carried by the export and the erasure cascade (P19-T1).
   */

  /** `YYYY-MM-DD`, a calendar day — never an instant, so no timezone moves it. At least 18 years ago. */
  @Prop({ type: String, default: null })
  dateOfBirth!: string | null;

  @Prop({ type: String, enum: [...GENDERS, null], default: null })
  gender!: Gender | null;

  /** `YYYY-MM`: the month they joined their **insurer** (*Joined Prudential*), not an office. */
  @Prop({ type: String, default: null })
  companyJoinMonth!: string | null;

  /**
   * **Full-time or part-time, as they said at registration**, before any office has them.
   *
   * Work status lives on the membership (`memberships.workStatus`, ADR-0158 §1) — it is how somebody
   * works *in an office*. A person who registers has no membership yet, so their answer waits here and
   * `HierarchyService` copies it onto the membership they are given, whichever way they join. Read by
   * nothing else once they belong somewhere.
   */
  @Prop({ type: String, enum: [...WORK_STATUSES, null], default: null })
  registeredWorkStatus!: WorkStatus | null;

  @Prop({ type: String, default: null })
  avatarUrl!: string | null;

  /**
   * **The language this person chose to read AgencyBoost in** (ADR-0179 §2; P18.98-T2): `'id'` or `'en'`, set by the
   * *ID | EN* switch and by *Language* on *Your account*, through `PATCH /auth/me`. It follows them to every device.
   *
   * **`null` is a person who has chosen nothing, and reads Bahasa Indonesia** (`languageOf`, `DEFAULT_LANGUAGE`).
   * Every account made before the switch holds `null` — nothing wrote the field until then (ADR-0016) — so there is no
   * migration. The reader's language, never the office's: `kpms.locale` stays `id-ID`.
   */
  @Prop({ type: String, enum: [...LANGUAGES, null], default: null })
  locale!: Language | null;

  @Prop({ type: String, default: null })
  timezone!: string | null;

  @Prop({ type: String, enum: ['super_admin', 'none'], default: 'none', index: true })
  platformRole!: 'super_admin' | 'none';

  @Prop({ type: String, enum: ['invited', 'active', 'deactivated'], default: 'invited', index: true })
  status!: 'invited' | 'active' | 'deactivated';

  @Prop({ type: Date, default: null })
  emailVerifiedAt!: Date | null;

  /**
   * They are signed in on a password somebody else chose for them.
   *
   * Set by the roster import (P3.6-T4), which generates one and hands it to the admin to
   * pass on. Until it is replaced, `AuthGuard` refuses every route but the ones that let
   * them replace it — a screen-level redirect would leave the temporary password working
   * against the API for as long as the account exists.
   *
   * Cleared by `POST /auth/change-password`, and by nothing else. A reset through the
   * forgot-password flow clears it too, because that also proves control of the mailbox.
   */
  @Prop({ type: Boolean, default: false })
  mustChangePassword!: boolean;

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
