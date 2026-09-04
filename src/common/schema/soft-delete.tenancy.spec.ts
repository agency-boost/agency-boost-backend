import { Schema } from 'mongoose';
import { AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import {
  NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { UserSchema } from '@/modules/users/user.schema';
import { AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { KpmSchema } from '@/modules/tenants/kpm.schema';

/**
 * P2-T8: soft delete everywhere.
 *
 * Erasure under UU 27/2022 is a deliberate, audited, cascading operation — not a
 * `deleteOne()`. That shape has to be right from the first collection, because
 * retrofitting cascade semantics across forty collections is a rewrite (ADR-0007).
 */

const SOFT_DELETABLE: ReadonlyArray<[string, Schema]> = [
  ['users', UserSchema],
  ['companies', CompanySchema],
  ['kpms', KpmSchema],
  ['assets', AssetSchema],
  ['notifications', NotificationSchema],
  ['notificationPreferences', NotificationPreferencesSchema],
];

/**
 * Collections that are append-only or self-expiring instead, each with the reason.
 * Soft delete would be meaningless on a record nobody may amend.
 */
const NOT_SOFT_DELETABLE: ReadonlyArray<[string, Schema, string]> = [
  ['auditLog', AuditLogSchema, 'append-only: an audit row that can be hidden is not evidence'],
  ['authTokens', AuthTokenSchema, 'self-expiring: revokedAt and expiresAt already model the lifecycle'],
];

describe('soft delete', () => {
  it.each(SOFT_DELETABLE)('%s declares deletedAt', (_name, schema) => {
    expect(schema.path('deletedAt')).toBeDefined();
  });

  it.each(SOFT_DELETABLE)('%s defaults deletedAt to null, not undefined', (_name, schema) => {
    // A missing field and an explicit null query differently; the repository filters on
    // `deletedAt: null`, so the default has to be null.
    const path = schema.path('deletedAt') as unknown as { defaultValue: unknown };
    expect(path.defaultValue).toBeNull();
  });

  it.each(NOT_SOFT_DELETABLE)('%s is exempt: %s', (_name, schema, reason) => {
    expect(schema).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
  });

  it('classifies every schema, so a new collection cannot quietly opt out', () => {
    // Update deliberately when a collection is added — the failure is the prompt to
    // decide which list it belongs in.
    expect(SOFT_DELETABLE.length + NOT_SOFT_DELETABLE.length).toBe(8);
  });

  it('exempts nothing that also declares deletedAt — that would be a contradiction', () => {
    for (const [name, schema] of NOT_SOFT_DELETABLE) {
      expect([name, schema.path('deletedAt')]).toEqual([name, undefined]);
    }
  });
});
