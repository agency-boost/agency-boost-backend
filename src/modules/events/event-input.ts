import { isValidObjectId } from 'mongoose';
import { Fields, refuseWith, type FieldSentence } from '@/common/validation/fields';
import { VALIDATION_REFUSALS } from '@/common/validation/validation.messages';
import {
  EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS, SELECT_AUDIENCE_SCOPES,
  type EventAudienceScope, type EventIssuer,
} from '@/domain/constants';
import { EVENTS_REFUSALS } from './events.messages';

/** What an event's fields are refused with (P18.10-T5 AC-3): this module's sentences, and the shared envelope's. */
const SAY = EVENTS_REFUSALS.VALIDATION_FAILED;
const FIELD = VALIDATION_REFUSALS.VALIDATION_FAILED;

export interface CheckedEventType {
  code?: string;
  label?: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
}

export interface CheckedEvent {
  code?: string;
  typeCode?: string;
  title?: string;
  blurb?: string;
  description?: string;
  startsAt?: Date;
  endsAt?: Date;
  location?: string;
  locationUrl?: string | null;
  audience: {
    issuer: EventIssuer;
    scope: EventAudienceScope;
    inviteeMembershipIds: string[];
  };
}

const LABEL = { min: 1, max: 80 } as const;
const TITLE = { min: 1, max: 200 } as const;

/** A hex colour, because the poster is an emoji on a background and a token would not travel. */
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * **A location link is a web address** (the exit review): `http` or `https` and nothing else. The card renders it as
 * a link with ↗ (`Overall.html:8493-8498`), and a `javascript:` or `data:` link there would run in the member's
 * session on a click.
 */
const WEB_LINK = /^https?:\/\/\S+$/i;

export function checkEventType(
  body: unknown, opts: { partial?: boolean } = {},
): CheckedEventType {
  const required = !opts.partial;
  const f = new Fields(body ?? {}, ['code', 'label', 'description', 'emoji', 'color']);
  const code = f.code('code', required);
  const label = f.text('label', LABEL, required);
  const description = f.note('description', { max: 200 });

  const source = (body ?? {}) as Record<string, unknown>;
  // **After** every field is read, not before: `Fields` pushes as it goes, and a copy taken
  // early drops everything the reads were about to find.
  const violations = [...f.violations];

  const emoji = optionalText(source.emoji, 'emoji', 8, violations);
  const color = optionalText(source.color, 'color', 7, violations);
  if (color && !HEX.test(color)) violations.push(SAY.colorHex);

  if (violations.length > 0) refuseWith(violations);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(emoji !== undefined ? { emoji } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

/**
 * One event, read field by field.
 *
 * **`endsAt` is required and must be after `startsAt`.** The prototype has a display time and no end
 * at all, which is why *"is it running now?"* had no answer and a status had to be typed in by hand.
 */
export function checkEvent(body: unknown, opts: { partial?: boolean } = {}): CheckedEvent {
  const required = !opts.partial;
  const allowed = [
    'code', 'typeCode', 'title', 'blurb', 'description',
    'startsAt', 'endsAt', 'location', 'locationUrl', 'audience',
  ];
  const f = new Fields(body ?? {}, allowed);
  const source = (body ?? {}) as Record<string, unknown>;

  const code = f.code('code', required);
  const typeCode = f.code('typeCode', required);
  const title = f.text('title', TITLE, required);
  const blurb = f.text('blurb', { min: 0, max: 300 }, false);
  const description = f.text('description', { min: 0, max: 4000 }, false);
  const location = f.text('location', { min: 0, max: 300 }, false);

  // **After** every `Fields` read, not before. `Fields` pushes as it goes, so a copy taken at
  // the top silently dropped every required-field and bounds violation it was about to find —
  // a body missing its code refused for its dates and said nothing about the code.
  const violations = [...f.violations];
  const locationUrl = optionalText(source.locationUrl, 'locationUrl', 500, violations);
  if (locationUrl && !WEB_LINK.test(locationUrl)) {
    violations.push(SAY.locationUrlWeb);
  }

  const startsAt = instant(source.startsAt, 'startsAt', required, violations);
  const endsAt = instant(source.endsAt, 'endsAt', required, violations);
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    violations.push(SAY.endsAfterStarts);
  }

  const audience = readAudience(source.audience, required, violations);

  if (violations.length > 0) refuseWith(violations);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(typeCode !== undefined ? { typeCode } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(blurb !== undefined ? { blurb } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(locationUrl !== undefined ? { locationUrl } : {}),
    ...(audience ? { audience } : {}),
  } as CheckedEvent;
}

function optionalText(
  raw: unknown, field: string, max: number, violations: FieldSentence[],
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    violations.push(FIELD.notText({ field }));
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) violations.push(SAY.textAtMost({ field, max }));
  return value || null;
}

/** An ISO instant. A date with no time is refused rather than assumed to mean midnight somewhere. */
function instant(
  raw: unknown, field: string, required: boolean, violations: FieldSentence[],
): Date | undefined {
  if (raw === undefined) {
    if (required) violations.push(FIELD.required({ field }));
    return undefined;
  }
  const value = new Date(String(raw));
  if (Number.isNaN(value.getTime())) {
    violations.push(SAY.notADateTime({ field }));
    return undefined;
  }
  return value;
}

function readAudience(
  raw: unknown, required: boolean, violations: FieldSentence[],
): CheckedEvent['audience'] | undefined {
  if (raw === undefined) {
    if (required) violations.push(FIELD.required({ field: 'audience' }));
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push(SAY.audienceNotObject);
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const issuer = String(row.issuer ?? '');
  const scope = String(row.scope ?? '');
  if (!(EVENT_ISSUERS as readonly string[]).includes(issuer)) {
    violations.push(SAY.issuerOneOf({ values: EVENT_ISSUERS }));
  }
  if (!(EVENT_AUDIENCE_SCOPES as readonly string[]).includes(scope)) {
    violations.push(SAY.scopeOneOf({ values: EVENT_AUDIENCE_SCOPES }));
  }

  const ids = Array.isArray(row.inviteeMembershipIds)
    ? row.inviteeMembershipIds.map((v) => String(v))
    : [];
  if (row.inviteeMembershipIds !== undefined && !Array.isArray(row.inviteeMembershipIds)) {
    violations.push(SAY.inviteesNotList);
  }
  // A membership id is an id: anything else is a malformed body, never a lookup (the exit review).
  const malformed = ids.filter((id) => !isValidObjectId(id));
  if (malformed.length > 0) {
    violations.push(SAY.inviteesMalformed({ count: malformed.length }));
  }
  // A list on a scope that does not take one is a body meaning two things at once.
  if (ids.length > 0 && !SELECT_AUDIENCE_SCOPES.includes(scope as EventAudienceScope)) {
    violations.push(SAY.scopeTakesNoList({ scope }));
  }

  return {
    issuer: issuer as EventIssuer,
    scope: scope as EventAudienceScope,
    inviteeMembershipIds: [...new Set(ids)],
  };
}
