import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { FilterQuery, Model } from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { LEADER_RUNG_CODES } from '@/domain/constants';
import type { KpmDocument } from '@/modules/tenants/kpm.schema';
import type { MembershipRepository } from './membership.repository';
import type { MembershipDocument } from './membership.schema';

/**
 * **The leader limit** (ADR-0113, P13.2-T4): what *Leaders used* counts, and the check every path
 * that makes a leader passes through.
 *
 * *Leaders used* is the office's memberships that are **active** — not pending, removed or deleted —
 * at the **AB or AAB** rung, the Owner and an Admin included at whichever of the two they stand on.
 * A named metric (`metrics-and-definitions.md`), and not ADR-0087's *leader*: an AAB with nobody
 * under them counts here, an Agent with a direct report does not.
 *
 * **One definition, read three ways**: the Super Admin's offices list and the *Edit subscription*
 * dialog through {@link countLeadersUsedPerOffice}, and the check through {@link countLeadersUsed}.
 * Both build their query from {@link leadersUsedFilter}, so they cannot count differently.
 */

/** The filter that is the metric. Soft-deleted rows are excluded by whoever applies it. */
export function leadersUsedFilter(): FilterQuery<MembershipDocument> {
  return { status: 'active', orgLevelCode: { $in: [...LEADER_RUNG_CODES] } };
}

/** Is this rung one the limit counts? A move between two such rungs changes nothing. */
export function isLeaderRung(orgLevelCode: string | null | undefined): boolean {
  return (LEADER_RUNG_CODES as readonly string[]).includes(String(orgLevelCode ?? '').toUpperCase());
}

/** *Leaders used* in the caller's own office, through the tenant-scoped repository. */
export function countLeadersUsed(members: MembershipRepository, ctx: RequestContext): Promise<number> {
  return members.count(ctx, leadersUsedFilter());
}

/**
 * *Leaders used* for each office named, for the Super Admin, through the repository's named unscoped
 * method (invariant §1). An office with nobody counted answers 0, never absent.
 */
export function countLeadersUsedPerOffice(
  members: MembershipRepository,
  ctx: RequestContext,
  kpmIds: string[],
): Promise<Map<string, number>> {
  return members.countPerOfficeAcrossTenants(ctx, kpmIds, leadersUsedFilter());
}

/**
 * The refusal (ADR-0113 §2): `409`, the maximum and the count in its details. Its sentence is the
 * API's; each screen writes its own words from the details, for the reader it has (AC-5).
 */
export function leaderLimitReached(maxLeaders: number, leadersUsed: number): DomainException {
  return new DomainException(
    ErrorCode.LEADER_LIMIT_REACHED,
    `This office has reached its limit of ${maxLeaders} leaders — ABs and AABs together, the Owner `
      + 'included. Nobody else can be made a leader until AgencyBoost raises it.',
    HttpStatus.CONFLICT,
    { maxLeaders, leadersUsed },
  );
}

/** How long a holder may keep the office's leader writes to itself before anyone may take them. */
const LEASE_MS = 10_000;
/** How long a waiting writer sleeps between asks. */
const WAIT_MS = 20;
/** How many asks before giving up: a little longer than a lease, so an abandoned one is always taken over. */
const ATTEMPTS = Math.ceil((LEASE_MS * 1.2) / WAIT_MS);

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export interface LeaderLimitDeps {
  kpms: Model<KpmDocument>;
  members: MembershipRepository;
  clock: Clock;
}

/**
 * Run a write that **adds one leader** to the caller's office, or refuse it.
 *
 * With no maximum there is no check and no lock: the write runs as it always did (AC-2). With one,
 * the write runs **holding the office's leader lease** — a conditional write on the office row that
 * only one writer can win — so the count and the write are one step to everybody else:
 *
 * 1. take the lease (`kpms.leaderLimitLock`), waiting while somebody else holds it;
 * 2. count *Leaders used*; refuse when one more would pass the maximum;
 * 3. write; 4. give the lease back, whatever happened.
 *
 * **Why a lease, and not a counter on the office.** A counter has to be kept in step with every
 * removal, demotion, approval and deletion, and a counter that drifts refuses a real promotion or
 * admits one too many with nothing to say so. The lease keeps the count a count of the rows that
 * exist, and makes two promotions at one below the limit take turns: the second counts the first's
 * write and is refused (AC-6). There are no transactions to do it with instead (ADR-0002). A holder
 * that dies mid-write is released when its lease passes, ten seconds on.
 *
 * Only writes that may add a leader take it, so every other join, move and promotion is untouched.
 *
 * **`addsLeader` is asked with the lease held** (P13.2 exit review). Whether a write adds a leader
 * depends on the member's row — their rung, and whether they are active yet — and a row read before
 * the lease can change before it is held: two promotions of one Agent both read *Agent*, and the
 * second was counted as a second leader. Asked here, the second reads the first's write, adds nobody
 * and is served. Left out, the write is taken to add one.
 *
 * **There is no path without an office.** A caller with no `kpmId` is a programming error, and it is
 * refused as one rather than let through unchecked, so no future caller can skip the limit by
 * arriving without the field.
 */
export async function withLeaderSeat<T>(
  deps: LeaderLimitDeps,
  ctx: RequestContext,
  work: () => Promise<T>,
  addsLeader: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<T> {
  const kpmId = ctx.kpmId;
  if (!kpmId) {
    throw new DomainException(
      ErrorCode.INTERNAL_ERROR,
      'The leader limit was asked about a write with no office in its context.',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  const office = await deps.kpms.findOne({ _id: kpmId, deletedAt: null }).select('subscription').exec();
  if (!office) throw new NotFoundException('KPM');
  if (office.subscription?.maxLeaders == null) return work();

  const { token, maxLeaders } = await takeLease(deps, kpmId);
  try {
    // Read with the lease held, so a maximum lowered a moment ago is the one obeyed, and the member's
    // row is the one the write is about to change.
    if (maxLeaders !== null && await addsLeader()) {
      const used = await countLeadersUsed(deps.members, ctx);
      if (used + 1 > maxLeaders) throw leaderLimitReached(maxLeaders, used);
    }
    return await work();
  } finally {
    await deps.kpms
      .updateOne({ _id: kpmId, 'leaderLimitLock.token': token }, { $set: { leaderLimitLock: null } })
      .exec();
  }
}

/**
 * Take the office's leader lease: free, or held past its time. Waits while it is held.
 *
 * Giving up is a `409 VERSION_CONFLICT` — somebody else is changing this office's leaders and has
 * been for longer than a lease — never `LEADER_LIMIT_REACHED`, which would be a claim about the
 * count that nobody made.
 */
async function takeLease(
  deps: LeaderLimitDeps,
  kpmId: string,
): Promise<{ token: string; maxLeaders: number | null }> {
  const token = randomUUID();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const now = deps.clock.now();
    const held = await deps.kpms
      .findOneAndUpdate(
        {
          _id: kpmId,
          deletedAt: null,
          // `null` matches an office row written before the field existed, too.
          $or: [{ leaderLimitLock: null }, { 'leaderLimitLock.until': { $lte: now } }],
        },
        { $set: { leaderLimitLock: { token, until: new Date(now.getTime() + LEASE_MS) } } },
        { new: true },
      )
      .select('subscription')
      .exec();
    if (held) return { token, maxLeaders: held.subscription?.maxLeaders ?? null };
    await pause(WAIT_MS);
  }
  throw new DomainException(
    ErrorCode.VERSION_CONFLICT,
    'Somebody else is changing this office’s leaders at this moment. Try again.',
    HttpStatus.CONFLICT,
  );
}
