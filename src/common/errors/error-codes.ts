/**
 * Stable, machine-readable error codes. Clients switch on these; `message` is written in the
 * reader's language — the request's `Accept-Language`, else the person's saved language
 * (P18.98-T5, ADR-0179 §7) — may change, and is never parsed. `code` and `details` are the
 * same in both languages.
 *
 * Every code here has a row in docs/02-specs/api/error-catalog.md, and its sentence, in
 * English and Indonesian, in its module's catalogue (`<module>.messages.ts`, filed under
 * the code: `refusals`, `common/i18n/sentence.ts`). A new failure mode without either fails
 * review, and one with no sentence in both languages fails `error-codes.spec.ts`.
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
  /**
   * A refresh or a sign-out carrying the refresh cookie, sent from a page whose `Origin` is not one
   * `CORS_ORIGINS` lists (P18.7-T1, ADR-0152). `403`. Every host shares the `agencyboost.id` site, so
   * the browser sends production's `SameSite=Lax` cookie from a staging page as well; CORS hides the
   * answer from that page but cannot stop the token rotating or the session ending. A request with
   * no `Origin` (a server, curl) is not refused.
   */
  AUTH_ORIGIN_REFUSED: 'AUTH_ORIGIN_REFUSED',
  /**
   * `POST /auth/refresh` was **given a refresh token, and it no longer works** (ADR-0168 §1): unknown or malformed,
   * expired, revoked (signed out, signed out everywhere, a password change) or already rotated away. `401`, one
   * code and one message for all of them, so the answer says the session ended and nothing of why. The browser
   * then knows this reader had a session — the sign-in page says *Your session ended. Sign in again.* A refresh
   * with **no token at all** is still `AUTH_TOKEN_INVALID`: there was no session to end.
   */
  AUTH_SESSION_ENDED: 'AUTH_SESSION_ENDED',
  /**
   * **The address asked for belongs to another account** (UI V1, UI-111; ADR-0181): `POST /auth/me/email` when the new
   * address is taken, and `POST /auth/verify-email-change` when it was taken between the request and the link. `409`,
   * `details: { field: 'newEmail' }`. Registration never says this — an address taken there is answered as a success
   * (the enumeration oracle) — but this route is behind a session and the password, and rate limited.
   */
  AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',

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
  /*
   * `LEAD_CONSENT_REQUIRED` was here: contact details with no recorded lawful basis (UU 27/2022).
   * Retired on 2026-10-07 with the field and its rule (ADR-0108 §1); the error catalog keeps its row,
   * marked retired, so a client that still branches on it can find out why it never comes.
   */
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
  /**
   * The office's subscription ended and it is not kept active (ADR-0112 §3, P13.2-T3). `403` on every
   * request of a member, from 00:00 of the office day after its end date; `details` carry `endDate`,
   * `kpmCode` and `branch`, which the app's page names. Raised in `ContextResolver` beside the
   * suspension, which wins, as an archive does. Never to the Super Admin, and never in a support session.
   */
  TENANT_SUBSCRIPTION_ENDED: 'TENANT_SUBSCRIPTION_ENDED',
  /**
   * A support session refused at its start because the office of the person named is **suspended or
   * archived** (P13.2 exit review): every request of the session would meet `TENANT_SUSPENDED` or
   * `TENANT_ARCHIVED`. `409`, with `kpmCode`, `branch` and `reason` (`suspended` | `archived`) in its
   * details. Its own code rather than the member's, so the console shows it on the support screen as
   * the console's error — the member's codes replace the app with the office-unavailable page, which is
   * a member's page and not the Super Admin's.
   */
  IMPERSONATION_OFFICE_UNAVAILABLE: 'IMPERSONATION_OFFICE_UNAVAILABLE',
  /**
   * A **setup** session named somebody who is neither an office's Owner nor one of its Admins (ADR-0162 §1):
   * a setup session acts as the person who configures an office, and anybody else has no settings to change.
   * `409`, with `details: { purpose: 'setup' }`; nothing is written and nobody is told. A support session as
   * the same person starts as before.
   */
  IMPERSONATION_SETUP_TARGET: 'IMPERSONATION_SETUP_TARGET',
  /**
   * A second start by the same Super Admin as the same person **within one second** (ADR-0168 §4): `iat` is in
   * seconds, so the two tokens are identical and the second session row's `tokenHash` collides with the first's.
   * `409`, and nothing is written for the second start — no row, no `impersonation.started`, no notice. It was a
   * `500`.
   */
  IMPERSONATION_JUST_STARTED: 'IMPERSONATION_JUST_STARTED',
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
   * An office was to be made in the Template library (ADR-0164 §3): the company that holds the platform's
   * templates is not an insurer, and holds no office. `409`, `details: { companyId }`; nothing is written.
   */
  COMPANY_IS_TEMPLATE_LIBRARY: 'COMPANY_IS_TEMPLATE_LIBRARY',
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
  /**
   * A rung's leader tier was to change while live memberships stand on it (ADR-0156 §5). Each member's class
   * was derived from the tier, so nobody is re-classed silently: `details.members` is how many to move first.
   */
  ORG_LEVEL_TIER_IN_USE: 'ORG_LEVEL_TIER_IN_USE',
  /** Somebody with an open request asked for a second office. */
  TENANT_REQUEST_ALREADY_OPEN: 'TENANT_REQUEST_ALREADY_OPEN',
  /** A KPM request was approved or declined already; the second decision says which. */
  TENANT_REQUEST_DECIDED: 'TENANT_REQUEST_DECIDED',

  // Organisation. The rest of the ORG_* family in the error catalog lands with the task
  // that can actually throw it — a code no path produces is a contract we do not honour.
  ORG_CYCLE_DETECTED: 'ORG_CYCLE_DETECTED',
  /**
   * A write that would take the office's *Leaders used* — its active ABs and AABs, the Owner
   * included — above the subscription's maximum (ADR-0113 §2, P13.2-T4). `409`, raised in
   * `HierarchyService.create` and `setLevel`, the two methods every path that makes a leader
   * passes through; `details` carry `maxLeaders` and `leadersUsed`. AB to AAB is never refused.
   */
  LEADER_LIMIT_REACHED: 'LEADER_LIMIT_REACHED',
  /**
   * A leader-limit request for a member who already has one waiting (ADR-0157 §2): one open request per subject.
   * `details.requestId` names the open one.
   */
  LEADER_LIMIT_REQUEST_OPEN: 'LEADER_LIMIT_REQUEST_OPEN',
  /**
   * An approved leader-limit request whose act no longer applies — the member left, moved rung, or was let in
   * some other way since it was asked (ADR-0157 §3). Nothing is written for the member; the request is closed as
   * declined, with that reason.
   */
  LEADER_LIMIT_REQUEST_STALE: 'LEADER_LIMIT_REQUEST_STALE',
  /** A leader-limit request decided or cancelled already; the second answer says which. */
  LEADER_LIMIT_REQUEST_DECIDED: 'LEADER_LIMIT_REQUEST_DECIDED',
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
  /**
   * *+ Add agent* for an agent code that already has an invite waiting in the company — this office's or another's
   * (ADR-0170 §2, P18.96-T3 AC-2). `409`. An agent code belongs to one person, so two invites for it could only let
   * two people try to be them. Resend the one waiting, or cancel it first.
   */
  ORG_INVITE_PENDING: 'ORG_INVITE_PENDING',
  /**
   * A transfer request for a member who already has one waiting (ADR-0170 §4, P18.96-T3 AC-3). `409`, one per member:
   * two would let the Owner approve both and move them twice. `details.transferId` names the open one.
   */
  ORG_TRANSFER_PENDING: 'ORG_TRANSFER_PENDING',
  /**
   * Approving a transfer request whose member **no longer reports to the leader it was asked from** (the P18.96 exit
   * review, L4): somebody moved them since. `409`, and the request is closed, `cancelled` — approving it would move
   * them from a unit nobody asked about. `details.transferId`. Whoever wants the move asks again.
   */
  ORG_TRANSFER_STALE: 'ORG_TRANSFER_STALE',
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
  /**
   * Tagging *Core Leader* a member whose rung is not a leader rung (ADR-0159 §1, P18.8-T5 AC-2). `400`. The tag is
   * a leader's: a Core Leader reads the whole office's analytics, and a tagged Agent would read every member's
   * production without leading anyone. Refused only when the tag is being **set**; a member already tagged and
   * since moved off a leader rung keeps the flag, and re-saving their other tags is not refused.
   */
  CORE_LEADER_NOT_A_LEADER: 'CORE_LEADER_NOT_A_LEADER',
  /**
   * **A leader's *Isi nomor WhatsApp* for somebody who already has a number** (the Phase 18.99 exit review, M1).
   * `409`, from `PUT /members/:membershipId/phone`: a leader fills a missing number, and never replaces one — a number on
   * file is the person's own to change, on *Profil saya* (`PATCH /auth/me`). The write is conditional on the stored
   * number being empty, so two leaders saving at once cannot overwrite each other either. Nothing is written.
   */
  MEMBER_PHONE_ON_FILE: 'MEMBER_PHONE_ON_FILE',
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

  /*
   * Coaching sessions (P11-T5; `functional/coaching.md`, *Errors*). Outside `COACH` is `NOT_FOUND`, never
   * a coaching code (P11-T3 AC-3): `COACHING_NOT_COACH_OF` and `COACHING_NOTES_PRIVATE` are not here.
   */
  /** A write to a finalized session — a draft save, a finalize, a goal save through it. `409`. */
  COACHING_SESSION_FINALIZED: 'COACHING_SESSION_FINALIZED',
  /** Finalize refused by one of the prototype's five checks; `details.rule` names the first. `422`. */
  COACHING_SESSION_INCOMPLETE: 'COACHING_SESSION_INCOMPLETE',
  /** A reopen of a draft or of a session already reopened. `409`, with `details.status`. */
  COACHING_SESSION_NOT_FINALIZED: 'COACHING_SESSION_NOT_FINALIZED',
  /** A reopen past `COACHING_REOPEN_WINDOW_DAYS` after the session's date (ADR-0079). `409`. */
  COACHING_REOPEN_WINDOW_CLOSED: 'COACHING_REOPEN_WINDOW_CLOSED',
  /** An Owner's or Admin's reopen of a session whose coach no longer coaches the coachee. `409`. */
  COACHING_REOPEN_COACH_NOT_CURRENT: 'COACHING_REOPEN_COACH_NOT_CURRENT',

  /*
   * Calendar (P12-T4; `functional/calendar.md`, *Errors*). Everything outside a reader's reach is
   * `NOT_FOUND`, never a calendar code: an entry the reader is not on, a write by anybody but its
   * organiser, a compare or a block outside `COACH`.
   */
  /** An answer from the member a block was placed on: a placement, not a request (ADR-0098). `409`. */
  CALENDAR_BLOCK_NOT_ANSWERABLE: 'CALENDAR_BLOCK_NOT_ANSWERABLE',

  /*
   * Activation (Phase 13; `functional/activation.md`, *Errors*). Everything outside a reader's reach is
   * `NOT_FOUND`, never an activation code: a hire nobody may see, an item code the pinned version lacks,
   * a reader with no activation at all.
   */
  /** A tick on an item whose link is live: it completes from the write its words name, never by hand (ADR-0031). `409`. */
  ACTIVATION_ITEM_AUTOMATIC: 'ACTIVATION_ITEM_AUTOMATIC',
  /** A write to an activation that is graduated, or past its six months and expired (OD-28, OD-120). `409`. */
  ACTIVATION_CLOSED: 'ACTIVATION_CLOSED',
  /** A graduation below 100%: every item, the linked ones included, is done first (OD-28). `409`. */
  ACTIVATION_INCOMPLETE: 'ACTIVATION_INCOMPLETE',
  /**
   * A bare hand tick of a **data-backed item** (P18.96-T4 AC-3, ADR-0171 §3): *Close first case independently*, *Reach
   * Independent Agent milestone* and *Weekly 1-on-1 check-in* are ticked by hand only with their record — the closing
   * it names, or the 1:1 — saved together. `422`, `details.code` and `details.form` (`closing` | `one_on_one`).
   */
  ACTIVATION_RECORD_REQUIRED: 'ACTIVATION_RECORD_REQUIRED',

  /*
   * Templates and the cascade types (P13.2-T6; ADR-0115; `functional/tenant-config.md`).
   */
  /**
   * Archiving an activity type the office's **activity binding** names, or a category while it holds one active
   * (ADR-0163 §5): the goal cascade, the summary and the pace count it. `409`, `details.codes` and `details.roles`.
   * It replaced `ACTIVITY_TYPE_RESERVED` (ADR-0115 §2), which refused the three platform codes in themselves.
   */
  ACTIVITY_TYPE_BOUND: 'ACTIVITY_TYPE_BOUND',
  /** A name an active template of the same company already has. `409`, `details.name`. */
  TEMPLATE_NAME_TAKEN: 'TEMPLATE_NAME_TAKEN',
  /** Archiving the company's default template: make another the default first. `409`. */
  TEMPLATE_IS_DEFAULT: 'TEMPLATE_IS_DEFAULT',
  /**
   * A copy into **another company** — *Import from another company*, or *Save as template* into a
   * company other than the office's — naming rung codes the destination's ladder lacks or has archived
   * (a ratio's or an activity section's `appliesToOrgLevelCodes`; ADR-0115 §6, P13.2-T7). `409`,
   * `details.codes`; raised before anything is written or copied.
   */
  TEMPLATE_RUNG_UNKNOWN: 'TEMPLATE_RUNG_UNKNOWN',

  /*
   * The Strategic Leader Forum (Phase 18.1; `functional/leader-forum.md`, *Errors*). Everything outside a
   * reader's reach is `NOT_FOUND`, never a forum code: another office's meeting or link, a deleted meeting, an
   * unknown, expired or revoked link, and every route for a field member not tagged *Core Leader*.
   */
  /** A move of a meeting once it is *Completed*: its date is the day its scorecard was frozen for (ADR-0130 §4). `409`. */
  LEADER_MEETING_COMPLETED: 'LEADER_MEETING_COMPLETED',
  /** A delete of a meeting somebody has written in — a meeting with minutes is never removed (ADR-0130 §5). `409`. */
  LEADER_MEETING_HAS_MINUTES: 'LEADER_MEETING_HAS_MINUTES',

  /*
   * Campaigns (Phase 18.5; `functional/campaigns.md`, *Errors*). Another office's, an archived or an unknown campaign
   * is `NOT_FOUND`, never a campaign code.
   */
  /** A chase or a drop on a campaign that has ended (D-lists): an upcoming one is chaseable, as drawn. `409`. */
  CAMPAIGN_NOT_OPEN: 'CAMPAIGN_NOT_OPEN',
  /** A chase by a rung the campaign does not apply to (`appliesToOrgLevelCodes`). `403`. */
  CAMPAIGN_NOT_ELIGIBLE: 'CAMPAIGN_NOT_ELIGIBLE',
  /**
   * An override, or its clearing, before the campaign's window is final (P18.6-T2; ADR-0144 §4): the last month it
   * reads has not locked, it is still running, or it never is (`rolling_12m`). `409`, `details.code`.
   */
  CAMPAIGN_STANDING_NOT_FINAL: 'CAMPAIGN_STANDING_NOT_FINAL',
  /**
   * An override, or its clearing, of the caller's own standing (P18.6 exit review, round 1; ADR-0138's rule, as
   * `EVENT_ATTENDANCE_SELF`): nobody corrects their own result. `400`, `details.membershipId`; nothing is written.
   */
  CAMPAIGN_OVERRIDE_SELF: 'CAMPAIGN_OVERRIDE_SELF',

  /*
   * Events (Phase 18.5, P18.5-T5 and T6; `functional/events.md`; OD-31). Outside a reader's audience or office, an
   * archived event and a membership outside the audience are `NOT_FOUND`, never one of these.
   */
  /** RSVP or cancel once the event has ended (`now >= endsAt`); a running event still takes both. `409`. */
  EVENT_RSVP_CLOSED: 'EVENT_RSVP_CLOSED',
  /** A claim, feedback or a roll-call save before the event has ended. `409`. */
  EVENT_NOT_ENDED: 'EVENT_NOT_ENDED',
  /** Feedback from a member who neither RSVP'd, said they came nor was confirmed (OD-31: either unlocks it). `409`. */
  EVENT_NOT_ATTENDED: 'EVENT_NOT_ATTENDED',
  /** A second answer to the same event: feedback is single-submit (`Overall.html:8758-8763`). `409`. */
  EVENT_FEEDBACK_ALREADY_SUBMITTED: 'EVENT_FEEDBACK_ALREADY_SUBMITTED',
  /** A roll-call save naming the caller's own membership: nobody confirms their own attendance (OD-31). `400`. */
  EVENT_ATTENDANCE_SELF: 'EVENT_ATTENDANCE_SELF',
  /** Moving an ended event that has an RSVP, a claim, a confirmation or feedback back into the future. `409`. */
  EVENT_HAS_RESPONSES: 'EVENT_HAS_RESPONSES',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VALIDATION_UNKNOWN_FIELD: 'VALIDATION_UNKNOWN_FIELD',
  VERSION_CONFLICT: 'VERSION_CONFLICT',

  // Storage
  ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
  ASSET_TYPE_NOT_ALLOWED: 'ASSET_TYPE_NOT_ALLOWED',
  ASSET_NOT_CONFIRMED: 'ASSET_NOT_CONFIRMED',
  ASSET_NOT_UPLOADED: 'ASSET_NOT_UPLOADED',
  /**
   * This instance has no storage bucket (P18.7-T2, D12): local development or a test without `GCS_BUCKET`. Every
   * upload signature, file link, copy and confirm is refused; nothing else is affected. `503` — see
   * `modules/assets/unconfigured-storage.ts` for why not `501`. Staging and production cannot raise it: they refuse
   * to boot without a bucket (`env.validation.ts`).
   */
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',

  // Generic
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
