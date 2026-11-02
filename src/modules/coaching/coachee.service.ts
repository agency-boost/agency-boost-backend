import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NoMembershipException, NotFoundException } from '@/common/errors/domain.exception';
import type { LocalDate } from '@/common/time/local-day';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames, type NamedPerson } from '@/modules/org/member-names.service';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import type { RosterPerson } from './coaching-roster.service';

/** How many people are below the coachee, and how many of those lead somebody. */
export interface CoacheeDownline {
  /** Everybody below them on the current leader edges, at any depth: who they would coach. */
  members: number;
  /** Those of them who lead anybody themselves: a leader is somebody with a report (ADR-0087). */
  leaders: number;
}

/** The person the shell opens on: directory facts, and no figure of theirs. */
export interface CoacheeView {
  /** The office's today, `YYYY-MM-DD`: what the page dates from, never the browser's clock. */
  today: LocalDate;
  membershipId: string;
  name: string;
  /** Their profile photo as a signed link (UI V1, UI-111); `null` for none: the header draws initials. */
  photoUrl: string | null;
  /** The coachee's own, so the copy about them reads *Leads that need her*. */
  pronoun: NamedPerson['pronoun'];
  rung: { code: string; label: string };
  /** The coachee's leader; `null` only when their membership cannot be named. */
  leader: RosterPerson | null;
  /** The reader is the coachee's leader: the prototype's *Direct unit*. */
  direct: boolean;
  downline: CoacheeDownline;
}

/**
 * **`GET /coaching/coachees/:membershipId` — the person the shell opens on** (P11-T7 AC-1, AC-8;
 * `functional/coaching.md`, the Data contract).
 *
 * **`COACH(reader, subject)`, and nothing wider.** The roster's rule, per person: somebody the reader
 * coaches is answered, and anybody else is 404 — a member outside the reader's downline, a peer's
 * person, a member of another office, a member who has left, a former coachee whose edge has closed,
 * and the reader themselves, whose own coaching is `/coaching/me` (ADR-0074, ADR-0078). The Owner and
 * the Admin hold `own-kpm` on `coaching_session:read` and coach nobody by it: one who stands above the
 * person as an AB coaches them as that AB, which is the hierarchy (roles §1.1).
 *
 * **Directory facts only, so no audit entry**: the name, the pronoun, the rung, the leader and how
 * many people are below them — what `GET /members/:membershipId` serves unaudited. No figure of the
 * coachee's is here; the tabs read those, and those reads write the §3.5 entry
 * (`functional/coaching.md`, *Audit and privacy*).
 *
 * **With the office's today** (`TenantDay`, from `kpms.timezone`): the day the page's dates count from,
 * so the browser never decides it from its own clock (invariant §9).
 *
 * **The downline counts are the resolver's**: everybody the coachee would coach, on the current edges
 * with every link active, and of those, everybody who leads one of them. The *Skill tracker*'s two
 * team grids read them: not applicable while nobody is below the coachee, or nobody below leads.
 */
@Injectable()
export class CoacheeService {
  constructor(
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly days: TenantDay,
  ) {}

  async read(ctx: RequestContext, membershipId: string): Promise<CoacheeView> {
    const me = ctx.membershipId;
    if (!me) throw new NoMembershipException();

    const member = await this.coach.coachee(ctx, me, membershipId);
    if (!member) throw new NotFoundException('Membership');

    // Somebody the reader coaches has the reader above them, so a leader of their own.
    const leaderId = member.leaderId as string;
    const [below, people, { today, ladder }] = await Promise.all([
      this.coach.coacheesOf(ctx, membershipId),
      // The coachee's photo signed for the header's avatar (UI V1, UI-111); their leader is only named.
      this.names.pictured(ctx, [membershipId, leaderId], [membershipId]),
      // The office's day, from the tenant's zone (invariant §9), and the ladder the roster labels a rung
      // from: the company's, which the office belongs to. One read of the office serves both.
      this.days.office(ctx).then(async (office) => ({
        today: office.today,
        ladder: office.companyId ? await this.orgLevels.list(ctx, office.companyId) : [],
      })),
    ]);

    const person = people.get(membershipId);
    const leaderName = people.get(leaderId)?.name;
    const code = member.orgLevelCode;
    const ids = new Set(below.map((c) => c.membershipId));
    const leading = new Set(below.map((c) => c.membership.leaderId).filter((id) => ids.has(id as string)));

    return {
      today,
      membershipId,
      name: person?.name ?? '',
      photoUrl: person?.photoUrl ?? null,
      pronoun: person?.pronoun ?? 'they',
      rung: { code, label: ladder.find((level) => level.code === code)?.label ?? code },
      leader: leaderName === undefined ? null : { membershipId: leaderId, name: leaderName },
      direct: leaderId === me,
      downline: { members: below.length, leaders: leading.size },
    };
  }
}
