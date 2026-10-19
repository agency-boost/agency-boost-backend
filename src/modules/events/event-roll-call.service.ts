import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, NoMembershipException, NotFoundException, PermissionDeniedException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { refuseWith } from '@/common/validation/fields';
import type { EventAttendanceStatus, EventPhase } from '@/domain/constants';
import type { NpsBucket } from '@/domain/metrics/event-nps';
import { AuditService, type AuditEntry } from '@/modules/audit/audit.service';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { can, scopeFor } from '@/modules/rbac/permissions';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { EventRsvpRepository } from './event.repository';
import { NPS_CONSTANTS, type NpsConstants } from './event-guest.service';
import { EventReadings, type FeedbackAttendance } from './event-readings';

export interface RollCallRow {
  membershipId: string;
  name: string;
  orgLevelCode: string;
  rung: string;
  /** *RSVP'd* / *Said they came* / —. An RSVP wins when both. */
  said: 'rsvp' | 'claimed' | null;
  attended: boolean | null;
  status: EventAttendanceStatus;
  /** The caller's own row: nobody confirms their own attendance (OD-31). */
  self: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  gaveFeedback: boolean;
}

export interface RollCall {
  eventId: string;
  title: string;
  phase: EventPhase;
  ended: boolean;
  startsOn: string;
  people: RollCallRow[];
  counts: {
    audience: number; attended: number; noShow: number; unconfirmed: number; registered: number; notRegistered: number;
  };
  attendanceRate: number | null;
  can: { confirm: boolean };
}

export interface EventInvitee {
  membershipId: string;
  name: string;
  orgLevelCode: string;
  rung: string;
  /** Leads somebody now — the graph, never the rung (ADR-0087, F-45). *Chosen leaders* lists only these. */
  leads: boolean;
}

export interface FeedbackRow {
  membershipId: string;
  name: string;
  score: number;
  bucket: NpsBucket;
  why: string;
  improve: string;
  submittedAt: string;
  attendance: FeedbackAttendance;
  counted: boolean;
}

export interface FeedbackSummary {
  eventId: string;
  title: string;
  nps: number | null;
  counted: number;
  responses: number;
  awaitingConfirmation: number;
  promoters: number;
  passives: number;
  detractors: number;
  rows: FeedbackRow[];
  constants: NpsConstants;
}

/** The most rows one roll-call save takes: an office's whole audience, with room. */
export const ROLL_CALL_MAX_ENTRIES = 500;

/**
 * **The office's side of an event** (P18.5-T5 AC-7, AC-10; P18.5-T6 AC-5; OD-31, OD-151, D-rollcall, D-picker): the
 * roll call in the *View feedback* dialog (`KPM_Owner.html:1655`), the *Feedback Summary* below it
 * (`KPM_Owner.html:3751-3795`), and the audience picker's people.
 *
 * **Only the Owner and the Admins confirm, and nobody their own** (OD-31): an Admin confirms the Owner's attendance,
 * the Owner an Admin's. A confirmation is the one thing that makes `attended`; a claim never does. **Names are shown**
 * to the Owner and the Admins with each answer (OD-151); no leader reads either.
 */
@Injectable()
export class EventRollCallService {
  constructor(
    private readonly readings: EventReadings,
    private readonly rsvps: EventRsvpRepository,
    private readonly memberships: MembershipRepository,
    private readonly names: MemberNames,
    private readonly orgLevels: OrgLevelService,
    private readonly tenantDay: TenantDay,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `GET /kpm/settings/events/invitees` — every active member, for *Chosen people* and *Chosen leaders*. */
  async invitees(ctx: RequestContext): Promise<{ people: EventInvitee[] }> {
    this.member(ctx);
    const rows = await this.memberships.find(
      ctx, { status: 'active' }, { projection: { orgLevelCode: 1, leaderId: 1 }, sort: { agentSeq: 1 } },
    );
    const ids = rows.map((row) => String(row._id));
    const leading = new Set(rows.map((row) => row.leaderId).filter((id): id is string => Boolean(id)));
    const [names, rungs] = await Promise.all([this.names.byMembershipId(ctx, ids), this.rungs(ctx)]);
    const people = rows.map((row): EventInvitee => ({
      membershipId: String(row._id),
      name: names.get(String(row._id)) ?? '',
      orgLevelCode: row.orgLevelCode,
      rung: rungs.get(row.orgLevelCode) ?? row.orgLevelCode,
      leads: leading.has(String(row._id)),
    }));
    return { people: people.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** `GET /kpm/settings/events/:eventId/attendance` — the audience as at the start, and each member's standing. */
  async rollCall(ctx: RequestContext, eventId: string): Promise<RollCall> {
    const me = this.member(ctx);
    const reading = await this.readings.attendance(ctx, eventId);
    if (!reading) throw new NotFoundException('Event');
    const ids = [
      ...reading.rows.map((r) => r.membershipId),
      ...reading.rows.map((r) => r.confirmedByMembershipId).filter((id): id is string => Boolean(id)),
    ];
    const [names, rungs] = await Promise.all([this.names.byMembershipId(ctx, ids), this.rungs(ctx)]);
    const people = reading.rows.map((row): RollCallRow => {
      const code = row.orgLevelCode;
      return {
        membershipId: row.membershipId,
        name: names.get(row.membershipId) ?? '',
        orgLevelCode: code,
        rung: rungs.get(code) ?? code,
        said: row.rsvp === 'going' ? 'rsvp' : row.claimed ? 'claimed' : null,
        attended: row.confirmed,
        status: row.status,
        self: row.membershipId === me,
        confirmedBy: row.confirmedByMembershipId ? names.get(row.confirmedByMembershipId) ?? '' : null,
        confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        gaveFeedback: row.gaveFeedback,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      eventId: reading.event.id,
      title: reading.event.title,
      phase: reading.event.phase,
      ended: reading.event.ended,
      startsOn: reading.event.startsOn,
      people,
      counts: {
        audience: reading.counts.audience,
        attended: reading.counts.attended,
        noShow: reading.counts.no_show,
        unconfirmed: reading.counts.unconfirmed,
        registered: reading.counts.registered,
        notRegistered: reading.counts.not_registered,
      },
      attendanceRate: reading.rate,
      can: { confirm: can(ctx, 'event_attendance:confirm') && reading.event.ended },
    };
  }

  /**
   * `PUT /kpm/settings/events/:eventId/attendance` — the confirmations: `true` attended, `false` marked absent,
   * `null` cleared back to unconfirmed. Only changed rows are written, each audited with before, after and the
   * confirmer. **The caller's own membership is refused whole** (`400 EVENT_ATTENDANCE_SELF`): nothing is written.
   */
  async saveRollCall(ctx: RequestContext, eventId: string, body: unknown): Promise<RollCall> {
    const me = this.member(ctx);
    const reading = await this.readings.attendance(ctx, eventId);
    if (!reading) throw new NotFoundException('Event');
    const entries = checkRollCall(body);
    if (entries.some((entry) => entry.membershipId === me)) {
      throw new DomainException(
        ErrorCode.EVENT_ATTENDANCE_SELF,
        'Nobody confirms their own attendance. Another administrator confirms yours.',
        HttpStatus.BAD_REQUEST,
        { membershipId: me },
      );
    }
    if (!reading.event.ended) {
      throw new DomainException(
        ErrorCode.EVENT_NOT_ENDED, 'Attendance is confirmed once the event has ended.', HttpStatus.CONFLICT,
      );
    }
    const byMember = new Map(reading.rows.map((row) => [row.membershipId, row]));
    // Somebody outside the audience as at the start is not on this roll call: the answer a stranger gets.
    if (entries.some((entry) => !byMember.has(entry.membershipId))) throw new NotFoundException('Membership');

    // The changed rows only, written in **one** unordered batch; each audited once written, even if another failed.
    const now = this.clock.now();
    const changes = entries.filter((entry) => byMember.get(entry.membershipId)!.confirmed !== entry.attended);
    if (changes.length > 0) {
      const result = await this.rsvps.setMany(ctx, reading.event.id, changes.map((entry) => ({
        membershipId: entry.membershipId,
        set: entry.attended === null
          ? { confirmedAttended: null, confirmedByMembershipId: null, confirmedAt: null }
          : { confirmedAttended: entry.attended, confirmedByMembershipId: me, confirmedAt: now },
      })));
      const audits = changes.flatMap((entry, i): AuditEntry[] => (result.failed.includes(i) ? [] : [{
        action: entry.attended === true ? 'event.attendance_confirmed'
          : entry.attended === false ? 'event.attendance_marked_absent' : 'event.attendance_cleared',
        targetCollection: 'eventRsvps',
        targetId: byMember.get(entry.membershipId)!.rowId ?? result.created[i] ?? null,
        targetMembershipId: entry.membershipId,
        before: { eventId: reading.event.id, attended: byMember.get(entry.membershipId)!.confirmed },
        after: { eventId: reading.event.id, attended: entry.attended, confirmedByMembershipId: me },
      }]));
      await this.audit.recordMany(ctx, audits);
      if (result.error) throw result.error;
    }
    return this.rollCall(ctx, eventId);
  }

  /**
   * `GET /kpm/settings/events/:eventId/feedback` — the *Feedback Summary* (`KPM_Owner.html:3751-3795`), with each
   * answer's author named (OD-151). **The office's administration's alone**: a member's own grant (`own`) reads their
   * own answer on `GET /events`, never this, and is refused `403`.
   */
  async feedbackSummary(ctx: RequestContext, eventId: string): Promise<FeedbackSummary> {
    this.member(ctx);
    const scope = scopeFor(ctx, 'event_feedback:read');
    if (scope !== 'own-kpm' && scope !== 'all') throw new PermissionDeniedException('event_feedback:read');
    const reading = await this.readings.feedbackSummary(ctx, eventId);
    if (!reading) throw new NotFoundException('Event');
    const names = await this.names.byMembershipId(ctx, reading.rows.map((r) => r.membershipId));
    const nameOf = (id: string) => names.get(id) ?? '';
    // By score, then by name (the contract): the order the Owner reads, whatever order the answers came in.
    const rows = [...reading.rows].sort((a, b) => b.score - a.score || nameOf(a.membershipId).localeCompare(nameOf(b.membershipId)));
    return {
      eventId: reading.event.id,
      title: reading.event.title,
      nps: reading.reading.nps,
      counted: reading.reading.n,
      responses: reading.responses,
      awaitingConfirmation: reading.awaitingConfirmation,
      promoters: reading.reading.promoters,
      passives: reading.reading.passives,
      detractors: reading.reading.detractors,
      rows: rows.map((row): FeedbackRow => ({
        membershipId: row.membershipId,
        name: nameOf(row.membershipId),
        score: row.score,
        bucket: row.bucket,
        why: row.why,
        improve: row.improve,
        submittedAt: row.submittedAt.toISOString(),
        attendance: row.attendance,
        counted: row.counted,
      })),
      constants: NPS_CONSTANTS,
    };
  }

  // -------------------------------------------------------------------- internals

  private member(ctx: RequestContext): string {
    if (!ctx.membershipId || !ctx.kpmId) throw new NoMembershipException();
    return ctx.membershipId;
  }

  /** The company ladder's labels, by rung code; an office whose row names no company labels nothing. */
  private async rungs(ctx: RequestContext): Promise<Map<string, string>> {
    const { companyId } = await this.tenantDay.office(ctx);
    if (!companyId) return new Map();
    return new Map((await this.orgLevels.list(ctx, companyId)).map((level) => [level.code, level.label]));
  }
}

/** The roll-call body: `{ entries: [{ membershipId, attended: true | false | null }] }`, 1 to 500, no repeats. */
export function checkRollCall(body: unknown): { membershipId: string; attended: boolean | null }[] {
  const violations: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(body)) refuseWith(['The change must be an object of fields.']);
  for (const key of Object.keys(body)) if (key !== 'entries') violations.push(`property ${key} should not exist`);
  const raw = body.entries;
  if (!Array.isArray(raw)) {
    violations.push('entries must be a list.');
    refuseWith(violations);
  }
  if (raw.length < 1 || raw.length > ROLL_CALL_MAX_ENTRIES) {
    violations.push(`entries must hold 1–${ROLL_CALL_MAX_ENTRIES} people.`);
  }
  const seen = new Set<string>();
  const entries: { membershipId: string; attended: boolean | null }[] = [];
  raw.forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(`entries[${i}] must be an object.`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'membershipId' && key !== 'attended') violations.push(`entries[${i}].${key} should not exist`);
    }
    const { membershipId, attended } = item;
    if (typeof membershipId !== 'string' || membershipId.trim() === '') {
      violations.push(`entries[${i}].membershipId is required.`);
      return;
    }
    if (attended !== true && attended !== false && attended !== null) {
      violations.push(`entries[${i}].attended must be true, false or null.`);
      return;
    }
    if (seen.has(membershipId)) violations.push(`entries[${i}] names ${membershipId} twice.`);
    seen.add(membershipId);
    entries.push({ membershipId, attended });
  });
  if (violations.length > 0) refuseWith(violations);
  return entries;
}
