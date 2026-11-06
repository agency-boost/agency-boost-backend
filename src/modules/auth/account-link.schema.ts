import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AccountLinkDocument = HydratedDocument<AccountLink>;

/**
 * **Two logins of one person, linked** (UI-169 item 5; ADR-0199 §3): the owner's *"normal account and the superadmin
 * account"*, so the avatar menu lists both logins' views and a switch moves between the two sessions this browser holds.
 *
 * **Global, with no `kpmId`**: logins are global (invariant 2), and a link may join a login that belongs to no office —
 * a Super Admin's — to one that does. **Nothing else is shared**: each login keeps its own memberships, grants,
 * password, sessions, inbox and audit trail, and a link grants no permission (ADR-0199 §8).
 *
 * **A login is in at most one live link** — a pair — in v1: the unique index below over `userIds`, a multikey index, so
 * no two live rows hold the same login. Removing a link soft-deletes it (`deletedAt`, `deletedBy`; invariant 6), which
 * frees both logins to be linked again.
 */
@Schema({ ...baseSchemaOptions, collection: 'accountLinks' })
export class AccountLink {
  /** The two logins, `users._id` as strings, **sorted**, so one pair is one spelling whichever side started it. */
  @Prop({ type: [String], required: true })
  userIds!: string[];

  /** The login that started it (`POST /auth/links`), whose pending link the other confirmed. */
  @Prop({ type: String, required: true })
  requestedBy!: string;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  /** Whoever removed it — either login of the pair (`DELETE /auth/links/:linkId`). */
  @Prop({ type: String, default: null })
  deletedBy!: string | null;
}

export const AccountLinkSchema = SchemaFactory.createForClass(AccountLink);
/*
 * One live link per login. `userIds` is an array, so the index is multikey: a second live row holding either login of
 * the first is a duplicate key, which the confirm answers `409 AUTH_LINK_EXISTS` when two confirms race.
 */
AccountLinkSchema.index({ userIds: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

/** The two logins of a pair as the row stores them: sorted. */
export function linkPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
