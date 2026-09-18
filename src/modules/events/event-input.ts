import { Fields, refuseWith } from '@/common/validation/fields';
import {
  EVENT_AUDIENCE_SCOPES, EVENT_ISSUERS, SELECT_AUDIENCE_SCOPES,
  type EventAudienceScope, type EventIssuer,
} from '@/domain/constants';

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
  if (color && !HEX.test(color)) violations.push('color must be a hex value such as #2D9CDB.');

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

  const startsAt = instant(source.startsAt, 'startsAt', required, violations);
  const endsAt = instant(source.endsAt, 'endsAt', required, violations);
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    violations.push('endsAt must be after startsAt.');
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
  raw: unknown, field: string, max: number, violations: string[],
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    violations.push(`${field} must be text.`);
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) violations.push(`${field} is at most ${max} characters.`);
  return value || null;
}

/** An ISO instant. A date with no time is refused rather than assumed to mean midnight somewhere. */
function instant(
  raw: unknown, field: string, required: boolean, violations: string[],
): Date | undefined {
  if (raw === undefined) {
    if (required) violations.push(`${field} is required.`);
    return undefined;
  }
  const value = new Date(String(raw));
  if (Number.isNaN(value.getTime())) {
    violations.push(`${field} is not a date and time.`);
    return undefined;
  }
  return value;
}

function readAudience(
  raw: unknown, required: boolean, violations: string[],
): CheckedEvent['audience'] | undefined {
  if (raw === undefined) {
    if (required) violations.push('audience is required.');
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    violations.push('audience must be an object of fields.');
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const issuer = String(row.issuer ?? '');
  const scope = String(row.scope ?? '');
  if (!(EVENT_ISSUERS as readonly string[]).includes(issuer)) {
    violations.push(`audience.issuer is one of: ${EVENT_ISSUERS.join(', ')}.`);
  }
  if (!(EVENT_AUDIENCE_SCOPES as readonly string[]).includes(scope)) {
    violations.push(`audience.scope is one of: ${EVENT_AUDIENCE_SCOPES.join(', ')}.`);
  }

  const ids = Array.isArray(row.inviteeMembershipIds)
    ? row.inviteeMembershipIds.map((v) => String(v))
    : [];
  if (row.inviteeMembershipIds !== undefined && !Array.isArray(row.inviteeMembershipIds)) {
    violations.push('audience.inviteeMembershipIds must be a list.');
  }
  // A list on a scope that does not take one is a body meaning two things at once.
  if (ids.length > 0 && !SELECT_AUDIENCE_SCOPES.includes(scope as EventAudienceScope)) {
    violations.push(
      `audience.scope "${scope}" invites everybody it describes, so it takes no invitee list.`,
    );
  }

  return {
    issuer: issuer as EventIssuer,
    scope: scope as EventAudienceScope,
    inviteeMembershipIds: [...new Set(ids)],
  };
}
