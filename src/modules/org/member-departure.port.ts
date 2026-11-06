import { RequestContext } from '@/common/context/request-context';

/**
 * **What another module does when a member leaves the office** (D-leave, P12-T4 AC-8).
 *
 * `RemovalService` calls it once the member's status is `removed` and their edge is closed, with the
 * remover's context, so every write it makes carries the actor of the removal. A port rather than an
 * import: the org module owns leaving, and a module that keeps per-member records — the calendar, whose
 * future entries a member who left can no longer keep — answers it without org depending on it.
 *
 * **It never fails the removal.** The removal is written before it is called, so `RemovalService` catches
 * and logs whatever it throws: a 500 after the fact would send the remover back to retry a removal that
 * has already happened.
 *
 * A closed leader edge needs no hook: `COACH` is resolved on the current edges at each request, so
 * compare and *Block time* end the moment an edge closes.
 */
export abstract class MemberDeparture {
  abstract left(ctx: RequestContext, membershipId: string): Promise<void>;
}

/**
 * **Every module's answer to one departure** (P18.2-T7 AC-5): the calendar's future entries and the campaigns' chases,
 * each a `MemberDeparture`, called in turn behind the one port `RemovalService` holds. Each runs whatever another
 * throws, and the first failure is rethrown once all have run — `RemovalService` logs it, as it always has.
 */
export class MemberDepartures extends MemberDeparture {
  constructor(private readonly each: readonly MemberDeparture[]) {
    super();
  }

  async left(ctx: RequestContext, membershipId: string): Promise<void> {
    const failures: unknown[] = [];
    for (const departure of this.each) {
      try {
        await departure.left(ctx, membershipId);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}
