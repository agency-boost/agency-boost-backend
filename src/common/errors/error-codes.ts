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

  // Organisation. The rest of the ORG_* family in the error catalog lands with the task
  // that can actually throw it — a code no path produces is a contract we do not honour.
  ORG_CYCLE_DETECTED: 'ORG_CYCLE_DETECTED',
  ORG_LEADER_NOT_IN_KPM: 'ORG_LEADER_NOT_IN_KPM',
  ORG_AGENT_ALREADY_TAGGED: 'ORG_AGENT_ALREADY_TAGGED',

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
