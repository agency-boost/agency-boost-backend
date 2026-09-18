import { BadRequestException, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import {
  DEFAULT_TENANT_TIMEZONE, SELECT_AUDIENCE_SCOPES, SEED_EVENT_TYPES,
  type EventPhase,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { EventDocument, EventTypeDocument } from './event.schema';
import { EventRepository, EventTypeRepository } from './event.repository';
import { checkEvent, checkEventType, type CheckedEvent } from './event-input';

export interface EventTypeView {
  id: string;
  code: string;
  label: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  displayOrder: number;
  status: 'active' | 'archived';
  /**
   * Bumped on every edit, so the publish gate notices one (P5-T9).
   *
   * The gate keys on which rows are present at which version, and a type with no version on its
   * view is a row it cannot see change — an Owner renaming a type would have got no publish
   * prompt and their agents would have kept the old label.
   */
  version: number;
  /** How many events name it — so *Archive* can say what it affects. */
  events: number;
}

export interface EventView {
  id: string;
  code: string;
  typeCode: string;
  title: string;
  blurb: string;
  description: string;
  startsAt: string;
  endsAt: string;
  /** The calendar day in the **office's** timezone, so no browser re-derives it in its own. */
  startsOn: string;
  location: string;
  locationUrl: string | null;
  audience: { issuer: string; scope: string; inviteeMembershipIds: string[] };
  /** Derived on every read, never stored (AC-3). */
  phase: EventPhase;
  status: 'active' | 'archived';
  version: number;
}

/**
 * The events an office runs (P5-T6, ADR-0034).
 *
 * **Nothing per-person lives here** (AC-6). RSVP, attendance and feedback are Phase 12's, each its
 * own per-member record — the prototype keeps all three on the shared event object, so with two
 * users the second overwrites the first's RSVP and reads the first's feedback as their own.
 */
@Injectable()
export class EventService {
  constructor(
    private readonly types: EventTypeRepository,
    private readonly events: EventRepository,
    private readonly memberships: MembershipRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- event types

  async listTypes(ctx: RequestContext, includeArchived = false): Promise<EventTypeView[]> {
    const rows = await this.types.find(
      ctx, includeArchived ? {} : { status: 'active' }, { sort: { displayOrder: 1 } },
    );
    const events = await this.events.find(ctx, {});
    const used = new Map<string, number>();
    for (const event of events) used.set(event.typeCode, (used.get(event.typeCode) ?? 0) + 1);
    return rows.map((row) => this.typeView(row, used.get(row.code) ?? 0));
  }

  async createType(ctx: RequestContext, body: unknown): Promise<EventTypeView> {
    const input = checkEventType(body);
    if (await this.types.exists(ctx, { code: input.code })) {
      throw new BadRequestException(`This office already has an event type with the code ${input.code}.`);
    }
    const last = await this.types.find(ctx, {}, { sort: { displayOrder: -1 }, limit: 1 });
    const created = await this.types.create(ctx, {
      ...input, displayOrder: (last[0]?.displayOrder ?? 0) + 1, version: 1, status: 'active',
    } as never);
    await this.record(ctx, 'event_type.created', 'eventTypes', created, { code: input.code });
    return this.typeView(created, 0);
  }

  async updateType(ctx: RequestContext, id: string, body: unknown): Promise<EventTypeView> {
    const input = checkEventType(body, { partial: true });
    // A code is the identity: an event that already happened points at it.
    delete (input as Record<string, unknown>).code;
    const updated = await this.types.updateById(ctx, id, {
      $set: input as never, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('EventType');
    await this.record(ctx, 'event_type.updated', 'eventTypes', updated, input as never);
    return this.typeView(updated, await this.events.count(ctx, { typeCode: updated.code }));
  }

  /**
   * Archive, never delete (AC-2).
   *
   * The prototype's control is a red **Delete**. An event that already happened renders the type it
   * was, and a type that vanished would leave every one of those events describing nothing.
   */
  async archiveType(ctx: RequestContext, id: string): Promise<EventTypeView> {
    return this.setTypeStatus(ctx, id, 'archived');
  }

  async restoreType(ctx: RequestContext, id: string): Promise<EventTypeView> {
    return this.setTypeStatus(ctx, id, 'active');
  }

  // ---------------------------------------------------------------- events

  async list(ctx: RequestContext, includeArchived = false): Promise<EventView[]> {
    const rows = await this.events.find(
      ctx, includeArchived ? {} : { status: 'active' }, { sort: { startsAt: 1 } },
    );
    const timezone = DEFAULT_TENANT_TIMEZONE;
    return rows.map((row) => this.view(row, timezone));
  }

  async create(ctx: RequestContext, body: unknown): Promise<EventView> {
    const input = checkEvent(body);
    await this.requireActiveType(ctx, input.typeCode!);
    await this.requireInvitees(ctx, input);
    if (await this.events.exists(ctx, { code: input.code })) {
      throw new BadRequestException(`This office already has an event with the code ${input.code}.`);
    }

    const created = await this.events.create(ctx, { ...input, version: 1, status: 'active' } as never);
    await this.record(ctx, 'event.created', 'events', created, { code: input.code });
    return this.view(created, DEFAULT_TENANT_TIMEZONE);
  }

  async update(ctx: RequestContext, id: string, body: unknown): Promise<EventView> {
    const input = checkEvent(body, { partial: true });
    delete (input as { code?: string }).code;
    if (input.typeCode) await this.requireActiveType(ctx, input.typeCode);
    if (input.audience) await this.requireInvitees(ctx, input as CheckedEvent);

    const updated = await this.events.updateById(ctx, id, {
      $set: input as never, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Event');
    await this.record(ctx, 'event.updated', 'events', updated, { code: updated.code });
    return this.view(updated, DEFAULT_TENANT_TIMEZONE);
  }

  async archive(ctx: RequestContext, id: string): Promise<EventView> {
    const updated = await this.events.updateById(ctx, id, {
      $set: { status: 'archived', archivedAt: this.clock.now() }, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Event');
    await this.record(ctx, 'event.archived', 'events', updated, { code: updated.code });
    return this.view(updated, DEFAULT_TENANT_TIMEZONE);
  }

  async restore(ctx: RequestContext, id: string): Promise<EventView> {
    const updated = await this.events.updateById(ctx, id, {
      $set: { status: 'active', archivedAt: null }, $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('Event');
    await this.record(ctx, 'event.restored', 'events', updated, { code: updated.code });
    return this.view(updated, DEFAULT_TENANT_TIMEZONE);
  }

  /** The event types a new office starts with. */
  async seedForOffice(ctx: RequestContext): Promise<number> {
    if (await this.types.exists(ctx, {})) return 0;
    for (const [index, type] of SEED_EVENT_TYPES.entries()) {
      await this.types.create(ctx, {
        ...type, description: null, displayOrder: index + 1, version: 1, status: 'active',
      } as never);
    }
    return SEED_EVENT_TYPES.length;
  }

  // -------------------------------------------------------------------- internals

  private async setTypeStatus(
    ctx: RequestContext, id: string, status: 'active' | 'archived',
  ): Promise<EventTypeView> {
    const updated = await this.types.updateById(ctx, id, {
      $set: { status, archivedAt: status === 'archived' ? this.clock.now() : null },
      $inc: { version: 1 },
    });
    if (!updated) throw new NotFoundException('EventType');
    await this.record(ctx, `event_type.${status === 'archived' ? 'archived' : 'restored'}`,
      'eventTypes', updated, { code: updated.code });
    return this.typeView(updated, await this.events.count(ctx, { typeCode: updated.code }));
  }

  private async requireActiveType(ctx: RequestContext, code: string): Promise<void> {
    const type = await this.types.findOne(ctx, { code });
    if (!type) throw new BadRequestException(`${code} is not an event type in this office.`);
    if (type.status === 'archived') {
      throw new BadRequestException(
        `${code} is archived, so no new event may be filed under it. Restore it first.`,
      );
    }
  }

  /**
   * Every invitee is an **active membership of the caller's own office** (AC-4).
   *
   * Another office's membership id is a 404 rather than a 403 — a 403 would confirm the id exists,
   * which is the thing the boundary is hiding.
   */
  private async requireInvitees(ctx: RequestContext, input: CheckedEvent): Promise<void> {
    const { scope, inviteeMembershipIds } = input.audience;
    if (!SELECT_AUDIENCE_SCOPES.includes(scope)) return;
    if (inviteeMembershipIds.length === 0) {
      throw new BadRequestException(
        'A "select" audience needs at least one person. Choose everybody instead if that is what '
        + 'you mean.',
      );
    }

    const found = await this.memberships.find(ctx, {
      _id: { $in: inviteeMembershipIds }, status: 'active',
    });
    if (found.length !== inviteeMembershipIds.length) {
      throw new NotFoundException('Membership');
    }

    if (scope === 'select_leaders') {
      // The **graph's** definition, never the role enum: an AAB with nobody under them leads
      // nobody, and inviting them on the strength of a job title is OD-50's class of defect.
      const notLeading = found.filter((m) => ((m as never as {
        directCounts?: { total?: number };
      }).directCounts?.total ?? 0) === 0);
      if (notLeading.length > 0) {
        throw new BadRequestException(
          `${notLeading.length} of the people you chose lead nobody, so they are not leaders for `
          + 'this purpose. Being an AB or an AAB is a rung; leading is having somebody under you.',
        );
      }
    }
  }

  private typeView(row: EventTypeDocument, events: number): EventTypeView {
    return {
      id: String(row._id),
      code: row.code,
      label: row.label,
      description: row.description,
      emoji: row.emoji,
      color: row.color,
      displayOrder: row.displayOrder,
      status: row.status,
      version: row.version,
      events,
    };
  }

  /**
   * One event, with its phase worked out now.
   *
   * **From the instants, not from a stored flag** (AC-3). The prototype hardcodes
   * `status: 'upcoming' | 'past'` beside a date it never checks against, and labels one record
   * *Running* in the list while its own data says `past`.
   *
   * `startsOn` is the calendar day in the **office's** timezone. Without it a browser groups by
   * its own — an agent travelling would see yesterday's event under today.
   */
  private view(row: EventDocument, timezone: string): EventView {
    const now = this.clock.now().getTime();
    const phase: EventPhase = now < row.startsAt.getTime()
      ? 'upcoming'
      : (now <= row.endsAt.getTime() ? 'running' : 'past');

    return {
      id: String(row._id),
      code: row.code,
      typeCode: row.typeCode,
      title: row.title,
      blurb: row.blurb,
      description: row.description,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      startsOn: new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(row.startsAt),
      location: row.location,
      locationUrl: row.locationUrl,
      audience: {
        issuer: row.audience.issuer,
        scope: row.audience.scope,
        inviteeMembershipIds: [...row.audience.inviteeMembershipIds],
      },
      phase,
      status: row.status,
      version: row.version,
    };
  }

  private record(
    ctx: RequestContext, action: string, targetCollection: string,
    target: { _id: unknown }, after: Record<string, unknown>,
  ) {
    return this.audit.record(ctx, {
      action, targetCollection, targetId: String(target._id), after,
    });
  }
}
