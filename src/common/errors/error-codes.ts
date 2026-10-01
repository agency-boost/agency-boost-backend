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

  /*
   * Activity logging (P6). The catalog carried these four rows from an earlier phase and the
   * module shipped producing none of them — found at the Phase 6 exit review. Three are real and
   * are raised here; `ACTIVITY_COUNT_OUT_OF_RANGE` was removed from the catalog instead, because
   * a count out of range is **clamped**, not refused (`activity-management.md` §4, invariant §7).
   */
  /** A day that has not happened in the office's timezone. */
  ACTIVITY_FUTURE_DATE: 'ACTIVITY_FUTURE_DATE',
  /** Past the office's backdating window: correctable, with a reason, but not editable (ADR-0042). */
  ACTIVITY_DATE_OUT_OF_WINDOW: 'ACTIVITY_DATE_OUT_OF_WINDOW',
  /**
   * A count filed against a section this member's rung is not shown (ADR-0020, P4-T18).
   *
   * Its own code because the client can act on it: the row should not have been on screen, so the
   * honest response is to reload the configuration rather than to show the agent a validation
   * message about a field they were offered.
   */
  ACTIVITY_TYPE_NOT_APPLICABLE: 'ACTIVITY_TYPE_NOT_APPLICABLE',

  /*
   * Leads (P7). The catalog has carried four `LEAD_*` codes since Phase 0, written ahead of the
   * module. They land here **one at a time, with the path that raises them** — the convention the
   * ORG_* note below states, and the one the ACTIVITY_* family above learned the hard way.
   *
   * `LEAD_STATUS_NOT_FINAL`, `LEAD_STATUS_WRONG_PIPELINE` and `LEAD_ALREADY_CLOSED` belong to
   * P7-T3, which is the task that can throw them.
   */
  /**
   * Contact details were to be stored with no recorded ground for holding them (UU 27/2022).
   *
   * **On the contact fields, not on the lead.** A name jotted down from a Thursday BOP is not
   * personal data the regulation governs; a phone number is. A gate on creation would make the
   * first thing an agent meets a compliance form, and the predictable outcome is a notebook.
   */
  LEAD_CONSENT_REQUIRED: 'LEAD_CONSENT_REQUIRED',
  /** A stage from the other ladder. Two vocabularies, so this is a type error, not a path rule. */
  LEAD_STATUS_WRONG_PIPELINE: 'LEAD_STATUS_WRONG_PIPELINE',
  /**
   * Marked **won** below the stage that closes the pipeline.
   *
   * The outcome is a claim about the world, not a position on a page — which is why *lost* is
   * allowed anywhere and this is not (§3.7). Free jump (ADR-0045) makes the path irrelevant and
   * this gate load-bearing: it is the only thing standing between a dropdown and a closed sale.
   */
  LEAD_STATUS_NOT_FINAL: 'LEAD_STATUS_NOT_FINAL',
  /** Already won or lost. Reopening is an explicit act, not a side effect of the next write. */
  LEAD_ALREADY_CLOSED: 'LEAD_ALREADY_CLOSED',
  /**
   * An assumption the goal cascade cannot make a plan from (P8-T2).
   *
   * **Catalogued since Phase 0 and raised by nothing until now**, the third of these this year —
   * the drift `ACTIVITY_COUNT_OUT_OF_RANGE` was removed for and `CONFIG_ARCHIVED` was finally
   * given a caller for in P7-T3.
   *
   * A non-positive case size or a conversion rate outside 0–100. The prototype coerces instead:
   * `parseNum(caseSize) || 1` turns a blank into **one rupiah**, which produces a target of a
   * hundred million policies and no hint that anything is wrong. Refusing by name lets the screen
   * point at the field.
   */
  GOAL_INVALID_ASSUMPTION: 'GOAL_INVALID_ASSUMPTION',
  /**
   * A write against a period that has ended (P8-T6, ADR-0042).
   *
   * **Catalogued since Phase 0 and raised by nothing until now** — the last of the three `GOAL_*`
   * codes written ahead of their paths, and the one the phase's exit criterion was waiting on.
   *
   * A record freezes when somebody relies on it. Last year's plan is what a leader coached
   * against and what a promotion case cites; rewriting it would make both of those claims about a
   * target that never existed. Re-planning the **current** period is ordinary and writes a new
   * version instead.
   */
  GOAL_PERIOD_LOCKED: 'GOAL_PERIOD_LOCKED',
  /**
   * New data written against archived configuration (invariant §3).
   *
   * **Catalogued since Phase 4 and raised by nothing until now.** It is one of six `CONFIG_*`
   * codes documented for shipped modules that no path produced — the drift the `ACTIVITY_*`
   * family above was caught in, older. P7-T3 is the first path to mean it: a lead may not be
   * moved onto a stage the office retired, while every lead already sitting on one still renders.
   */
  CONFIG_ARCHIVED: 'CONFIG_ARCHIVED',

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
  AGENT_CODE_TAKEN: 'AGENT_CODE_TAKEN',
  AUTH_PASSWORD_CHANGE_REQUIRED: 'AUTH_PASSWORD_CHANGE_REQUIRED',
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

  // Configuration
  /**
   * **Retired by ADR-0024** — an office may change any ratio's formula, and a row that no
   * longer matches what it was seeded from is flagged rather than refused.
   *
   * Kept and never reused. It shipped, so a client may still have a branch on it, and a code
   * that once meant one thing must not come back meaning another — the same reasoning
   * invariant §3 gives for configuration codes.
   */
  CONFIG_RATIO_FORMULA_FIXED: 'CONFIG_RATIO_FORMULA_FIXED',
  /** A rung named in an applicability list is not active on the company's ladder. */
  CONFIG_RUNG_UNKNOWN: 'CONFIG_RUNG_UNKNOWN',
  /** A ratio counts activity nobody on one of its rungs can log (ADR-0020). */
  CONFIG_RATIO_UNREACHABLE_INPUT: 'CONFIG_RATIO_UNREACHABLE_INPUT',
  /** A ratio's display unit does not fit its rule — `band` is points, `gte` never is. */
  CONFIG_RATIO_UNIT_MISMATCH: 'CONFIG_RATIO_UNIT_MISMATCH',
  /**
   * Two sections share a summary tile and disagree on what it is called (ADR-0064). `422`, with
   * `details: { summaryGroupCode, labels }`.
   *
   * **Refused, not reconciled.** One tile has one label, and picking either would rename a tile
   * somebody else set. Counted across every section the office holds, archived included — an
   * archived section still renders the days it was logged against.
   */
  CONFIG_SUMMARY_GROUP_LABEL_MISMATCH: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
  /**
   * A shared summary tile's code is also the code of a section outside it (ADR-0064, P10.1-T6).
   * `422`, with `details: { summaryGroupCode, label }`.
   *
   * A section with a tile of its own is a tile under its own code, so the two would be two tiles
   * with one code — two chips one reader cannot tell apart by it. Archived sections count.
   */
  CONFIG_SUMMARY_GROUP_CODE_TAKEN: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN',

  /*
   * Production import (P9-T3, P9-T4). The catalog has carried seven `UPLOAD_*` codes since Phase 0;
   * each landed with the path that raises it, and two were added that it did not have.
   *
   * **Two are thrown, three are reported.** A file whose header nobody issued, or that cannot be read
   * at all, is refused whole. A row or a cell that is wrong is reported **inside the preview** and
   * the rest of the file still previews — the prototype discards eleven good values for one bad one.
   */
  /** The header is not one this product issued. Nothing is previewed. */
  UPLOAD_TEMPLATE_MISMATCH: 'UPLOAD_TEMPLATE_MISMATCH',
  /** Not a CSV at all, or unbalanced quotes; row-level for one row with more cells than the template. */
  UPLOAD_MALFORMED_CSV: 'UPLOAD_MALFORMED_CSV',
  /** Row-level: no active member of this office answers to the code. */
  UPLOAD_UNKNOWN_AGENT_CODE: 'UPLOAD_UNKNOWN_AGENT_CODE',
  /** Row-level: two rows resolve to one member, so neither is taken (ADR-0052). */
  UPLOAD_DUPLICATE_AGENT_CODE: 'UPLOAD_DUPLICATE_AGENT_CODE',
  /** Cell-level: not a number, the wrong sign, the wrong mark, above 100, a fraction of a person. */
  UPLOAD_VALUE_OUT_OF_RANGE: 'UPLOAD_VALUE_OUT_OF_RANGE',
  /** A write to a month past its window, or locked by hand, and not reopened (ADR-0050). */
  UPLOAD_MONTH_LOCKED: 'UPLOAD_MONTH_LOCKED',
  /** This very preview — the same file against the same month revision — was committed already. */
  UPLOAD_BATCH_ALREADY_COMMITTED: 'UPLOAD_BATCH_ALREADY_COMMITTED',
  /** The import is not standing: reverted already, or never committed. */
  UPLOAD_NOTHING_TO_REVERT: 'UPLOAD_NOTHING_TO_REVERT',
  /** A later import of the month is still standing; it is reverted first, so each revert is exact. */
  UPLOAD_BATCH_NOT_LATEST: 'UPLOAD_BATCH_NOT_LATEST',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VALIDATION_UNKNOWN_FIELD: 'VALIDATION_UNKNOWN_FIELD',
  VERSION_CONFLICT: 'VERSION_CONFLICT',

  // Storage
  ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
  ASSET_TYPE_NOT_ALLOWED: 'ASSET_TYPE_NOT_ALLOWED',
  ASSET_NOT_CONFIRMED: 'ASSET_NOT_CONFIRMED',
  ASSET_NOT_UPLOADED: 'ASSET_NOT_UPLOADED',

  // Generic
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
