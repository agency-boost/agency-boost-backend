/**
 * Stable, machine-readable error codes. Clients switch on these; `message` is English,
 * may change, and is never parsed.
 *
 * Every code here has a row in docs/02-specs/api/error-catalog.md. A new failure mode
 * without a catalog entry fails review.
 */
export const ErrorCode = {
  // Authentication
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
  AUTH_ACCOUNT_DEACTIVATED: 'AUTH_ACCOUNT_DEACTIVATED',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',

  // Tenant. Note there is deliberately NO cross-tenant code — see NOT_FOUND.
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_ARCHIVED: 'TENANT_ARCHIVED',
  TENANT_NO_MEMBERSHIP: 'TENANT_NO_MEMBERSHIP',
  TENANT_CODE_TAKEN: 'TENANT_CODE_TAKEN',
  /**
   * A company already holds that slug. Its own code rather than a generic conflict,
   * because the form derives the slug from the name now: two differently-punctuated
   * names produce the same slug, and the reader never chose it, so the refusal has to
   * name the company they collided with.
   */
  COMPANY_SLUG_TAKEN: 'COMPANY_SLUG_TAKEN',
  /**
   * A company already has a level with that code — **including an archived one**. An
   * archived code is never reused: a membership still pointing at the old rung would
   * quietly come to mean the new one.
   */
  ORG_LEVEL_CODE_TAKEN: 'ORG_LEVEL_CODE_TAKEN',
  /**
   * A membership was to be written against a rung the company's ladder does not have, or
   * has archived. Never expected in normal use — every company is seeded with a ladder —
   * so it is a loud refusal rather than a silent null on the membership.
   */
  ORG_LEVEL_NOT_ON_LADDER: 'ORG_LEVEL_NOT_ON_LADDER',
  /** Somebody with an open request asked for a second office. */
  TENANT_REQUEST_ALREADY_OPEN: 'TENANT_REQUEST_ALREADY_OPEN',
  /** A KPM request was approved or declined already; the second decision says which. */
  TENANT_REQUEST_DECIDED: 'TENANT_REQUEST_DECIDED',

  // Organisation. The rest of the ORG_* family in the error catalog lands with the task
  // that can actually throw it — a code no path produces is a contract we do not honour.
  ORG_CYCLE_DETECTED: 'ORG_CYCLE_DETECTED',
  ORG_LEADER_NOT_IN_KPM: 'ORG_LEADER_NOT_IN_KPM',
  ORG_AGENT_ALREADY_TAGGED: 'ORG_AGENT_ALREADY_TAGGED',
  /**
   * The untagged pool is office-wide, so its *list* is filtered and its *argument* has to
   * be too. Refuses tagging the office's root or owner, and — for anybody but the office
   * — tagging an orphan who still leads a unit, which would hand a peer that whole unit.
   */
  ORG_NOT_PERMITTED_TO_TAG: 'ORG_NOT_PERMITTED_TO_TAG',
  // Unknown, revoked and expired all answer with EXPIRED, deliberately: a six-character
  // code whose reward is joining somebody's unit must not tell a prober which of the
  // three they hit.
  ORG_INVITE_EXPIRED: 'ORG_INVITE_EXPIRED',
  ORG_INVITE_EXHAUSTED: 'ORG_INVITE_EXHAUSTED',
  ORG_REQUEST_ALREADY_DECIDED: 'ORG_REQUEST_ALREADY_DECIDED',
  ORG_ROLE_CHANGE_NOT_PERMITTED: 'ORG_ROLE_CHANGE_NOT_PERMITTED',
  ORG_HAS_DIRECT_REPORTS: 'ORG_HAS_DIRECT_REPORTS',
  ORG_REMOVAL_NOT_CONFIRMED: 'ORG_REMOVAL_NOT_CONFIRMED',
  ORG_REMOVAL_NOT_PERMITTED: 'ORG_REMOVAL_NOT_PERMITTED',
  ORG_SUBTREE_DISPOSITION_REQUIRED: 'ORG_SUBTREE_DISPOSITION_REQUIRED',
  ORG_ALREADY_REMOVED: 'ORG_ALREADY_REMOVED',
  ORG_TREE_TOO_LARGE: 'ORG_TREE_TOO_LARGE',
  ORG_GROUP_NAME_TAKEN: 'ORG_GROUP_NAME_TAKEN',
  ORG_GROUP_OWNER_NOT_IN_KPM: 'ORG_GROUP_OWNER_NOT_IN_KPM',
  ORG_GROUP_NOT_FOUND: 'ORG_GROUP_NOT_FOUND',
  ORG_ALREADY_ADMIN: 'ORG_ALREADY_ADMIN',
  ORG_NOT_AN_ADMIN: 'ORG_NOT_AN_ADMIN',
  ORG_ADMIN_TARGET_NOT_ACTIVE: 'ORG_ADMIN_TARGET_NOT_ACTIVE',

  // Authorization
  PERM_DENIED: 'PERM_DENIED',
  PERM_OUT_OF_SCOPE: 'PERM_OUT_OF_SCOPE',
  PERM_OWNER_ONLY: 'PERM_OWNER_ONLY',
  PERM_LAST_OWNER: 'PERM_LAST_OWNER',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VALIDATION_UNKNOWN_FIELD: 'VALIDATION_UNKNOWN_FIELD',
  VERSION_CONFLICT: 'VERSION_CONFLICT',

  // Storage
  ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
  ASSET_TYPE_NOT_ALLOWED: 'ASSET_TYPE_NOT_ALLOWED',
  ASSET_SCAN_PENDING: 'ASSET_SCAN_PENDING',

  // Generic
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
