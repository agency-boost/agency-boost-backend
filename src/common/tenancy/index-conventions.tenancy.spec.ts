import { Schema } from 'mongoose';
import { AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AssetSchema } from '@/modules/assets/asset.schema';
import {
  NotificationSchema,
  NotificationPreferencesSchema,
} from '@/modules/notifications/notification.schema';
import { AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { CompanySchema } from '@/modules/tenants/company.schema';
import { KpmSchema } from '@/modules/tenants/kpm.schema';
import { UserSchema } from '@/modules/users/user.schema';
import { GroupSchema } from '@/modules/org/group.schema';
import { InviteCodeSchema } from '@/modules/org/invite-code.schema';
import { JoinRequestSchema } from '@/modules/org/join-request.schema';
import { MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipSchema } from '@/modules/org/membership.schema';
import { unclassified } from '@/common/schema/registered-schemas';

/**
 * An index on a tenant-scoped collection that does not lead with `kpmId` invites a
 * query plan that scans across tenants. MongoDB has no row-level-security backstop
 * (ADR-0002), so index shape is part of the isolation guarantee, not just performance.
 *
 * This asserts the convention over every registered schema, so a new collection cannot
 * quietly opt out.
 */

/** Schemas whose documents belong to exactly one tenant. */
const TENANT_SCOPED: ReadonlyArray<[string, Schema]> = [
  ['assets', AssetSchema],
  ['notifications', NotificationSchema],
  ['memberships', MembershipSchema],
  ['membershipHistory', MembershipHistorySchema],
  ['joinRequests', JoinRequestSchema],
  ['inviteCodes', InviteCodeSchema],
  ['groups', GroupSchema],
];

/**
 * Schemas that are deliberately not tenant-scoped, each with the reason. Anything not
 * listed here and not above is a schema nobody classified — which is itself a finding.
 */
const EXEMPT: ReadonlyArray<[string, Schema, string]> = [
  ['auditLog', AuditLogSchema, 'kpmId is nullable: platform actions belong to no tenant'],
  [
    'notificationPreferences',
    NotificationPreferencesSchema,
    'keyed by global userId: a person carries preferences across offices',
  ],
  [
    'users',
    UserSchema,
    'identity is global: one person, one account, one login across every office they join',
  ],
  ['companies', CompanySchema, 'a company owns KPMs; it sits above the tenant, not inside one'],
  ['kpms', KpmSchema, 'the tenant record itself — it cannot be scoped to itself'],
  [
    'authTokens',
    AuthTokenSchema,
    'issued against a global identity before any office is chosen: refresh, email ' +
      'verification and password reset all predate membership',
  ],
];

/**
 * Indexes that deliberately do not lead with `kpmId`, each with its justification.
 *
 * The rule is not "every index leads with kpmId" — some queries are legitimately
 * per-user across tenants. The rule is that such an index is *declared* here, so it is
 * a decision somebody made rather than an oversight.
 */
const CROSS_TENANT_INDEXES: Record<string, string> = {
  'notifications:userId,readAt,createdAt':
    "the recipient's own inbox. kpmId is nullable here because email verification and " +
    'password reset are sent before a user has joined any KPM, so the inbox query is ' +
    'per-user by design and reads only that user’s own rows.',
};

/**
 * The exported const name for a schema instance, so the classification lists can be
 * compared against what the source tree exports without repeating the names by hand.
 */
const SCHEMA_EXPORT_NAMES = new Map<Schema, string>([
  [AssetSchema, 'AssetSchema'],
  [NotificationSchema, 'NotificationSchema'],
  [NotificationPreferencesSchema, 'NotificationPreferencesSchema'],
  [AuditLogSchema, 'AuditLogSchema'],
  [AuthTokenSchema, 'AuthTokenSchema'],
  [CompanySchema, 'CompanySchema'],
  [KpmSchema, 'KpmSchema'],
  [UserSchema, 'UserSchema'],
  [GroupSchema, 'GroupSchema'],
  [InviteCodeSchema, 'InviteCodeSchema'],
  [JoinRequestSchema, 'JoinRequestSchema'],
  [MembershipHistorySchema, 'MembershipHistorySchema'],
  [MembershipSchema, 'MembershipSchema'],
]);

function schemaExportName(schema: Schema): string {
  const name = SCHEMA_EXPORT_NAMES.get(schema);
  if (!name) throw new Error('Schema missing from SCHEMA_EXPORT_NAMES — add it.');
  return name;
}

function compoundIndexes(schema: Schema): Record<string, number | string>[] {
  return schema
    .indexes()
    .map(([fields]) => fields as Record<string, number | string>)
    .filter((fields) => Object.keys(fields).length > 1);
}

describe('index conventions', () => {
  describe.each(TENANT_SCOPED)('%s', (_name: string, schema: Schema) => {
    it('declares kpmId on the schema', () => {
      expect(schema.path('kpmId')).toBeDefined();
    });

    it('serves the tenant filter with at least one kpmId-leading compound index', () => {
      const tenantLed = compoundIndexes(schema).filter(
        (fields) => Object.keys(fields)[0] === 'kpmId',
      );
      expect(tenantLed.length).toBeGreaterThan(0);
    });

    it('declares any index that does not lead with kpmId, with a reason', () => {
      const undeclared = compoundIndexes(schema)
        .filter((fields) => Object.keys(fields)[0] !== 'kpmId')
        .map((fields) => `${_name}:${Object.keys(fields).join(',')}`)
        .filter((key) => !CROSS_TENANT_INDEXES[key]);

      // A new index that scans across tenants must be justified in CROSS_TENANT_INDEXES,
      // not silently added.
      expect(undeclared).toEqual([]);
    });
  });

  describe.each(EXEMPT)('%s (exempt)', (_name, schema, reason) => {
    it(`is exempt for a stated reason: ${reason}`, () => {
      expect(reason.length).toBeGreaterThan(10);
      expect(schema).toBeDefined();
    });
  });

  it('classifies every schema as scoped or exempt, so none is overlooked', () => {
    // This compared `TENANT_SCOPED.length + EXEMPT.length` to a literal until 2026-09-06,
    // which is a tautology: both sides came from the lists, so it could only fail if
    // somebody edited a list and forgot the number. Phase 3 added five collections and it
    // stayed green through all of them. The names now come from the source tree, so a new
    // `*.schema.ts` fails here until it is classified.
    const missing = unclassified([
      ...TENANT_SCOPED.map(([, schema]) => schemaExportName(schema)),
      ...EXEMPT.map(([, schema]) => schemaExportName(schema)),
    ]);
    expect(missing).toEqual([]);
  });
});
