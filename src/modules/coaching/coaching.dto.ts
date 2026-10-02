/**
 * **Empty on purpose** (P11-T6): the roster is the reader's own reach, with nothing to filter, page or
 * name. A class with no fields is how the validation pipe refuses a query parameter by name — a
 * `membershipId` asking for somebody else's roster included — rather than ignoring it.
 */
export class CoachingRosterQueryDto {}

/**
 * **Empty on purpose** too (`GET /coaching/coachees/:membershipId`): the path names the person, and
 * nothing else is asked of the caller. A query parameter of any name — a `for`, a second id — is refused
 * by name, as the roster's is, rather than ignored.
 */
export class CoacheeQueryDto {}
