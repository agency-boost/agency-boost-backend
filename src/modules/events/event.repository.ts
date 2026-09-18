import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Event, EventDocument, EventType, EventTypeDocument } from './event.schema';

/** An office's event types. Through the chokepoint, like every other taxonomy (invariant §1). */
@Injectable()
export class EventTypeRepository extends TenantScopedRepository<EventTypeDocument> {
  constructor(@InjectModel(EventType.name) model: Model<EventTypeDocument>) {
    super(model, 'eventTypes');
  }
}

/** An office's events. */
@Injectable()
export class EventRepository extends TenantScopedRepository<EventDocument> {
  constructor(@InjectModel(Event.name) model: Model<EventDocument>) {
    super(model, 'events');
  }
}
