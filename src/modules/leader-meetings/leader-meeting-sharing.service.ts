import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { LEADER_MEETING_SHARE_DAYS, LEADER_MEETING_SHARE_TOKEN_BYTES, TIME } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { LeaderMeetingPeople, meetingNotFound } from './leader-meeting-people';
import { LeaderMeetingShareLinkRepository } from './leader-meeting-share-link.repository';
import { LeaderMeetingRepository } from './leader-meeting.repository';
import type { MeetingView, ShareLink } from './leader-meeting.view';
import { LeaderMeetingsService } from './leader-meetings.service';

/** The audit trail's name for the links (`targetCollection`). */
const LINKS = 'leaderMeetingShareLinks';

/** A token as it is stored: its hex SHA-256, never the token. */
export const tokenHashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * **A meeting's shared links** (OD-146, ADR-0131, D-share; `functional/leader-forum.md`, *Sharing*).
 *
 * - ***Share* makes a fresh link each time** — a random token of `LEADER_MEETING_SHARE_TOKEN_BYTES`, base64url —
 *   because only its hash is kept, so a link once made cannot be shown again (*Noted* 1). It opens for
 *   `LEADER_MEETING_SHARE_DAYS`; ***Stop sharing* revokes every live link to the meeting**, since a link that cannot
 *   be shown cannot be picked out.
 * - **Opening one** is for every signed-in member of the office, any rung, tagged or not: the meeting **read-only**,
 *   and every opening one audit row, failing open. An unknown, expired or revoked link, a deleted meeting and
 *   another office's link are **one answer**, 404, looked up inside the reader's own office. An opening after the
 *   meeting's date can be the read that freezes it (ADR-0129 §7).
 * - No write route takes a token: whoever arrives by a link edits nothing through it.
 */
@Injectable()
export class LeaderMeetingSharing {
  constructor(
    private readonly links: LeaderMeetingShareLinkRepository,
    private readonly meetings: LeaderMeetingRepository,
    private readonly forum: LeaderMeetingsService,
    private readonly people: LeaderMeetingPeople,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** `POST /leader-meetings/:meetingId/share-links`: a fresh link, its token in this answer and nowhere else. */
  async create(ctx: RequestContext, meetingId: string): Promise<ShareLink> {
    await this.people.editor(ctx);
    if (!(await this.meetings.findById(ctx, meetingId))) throw meetingNotFound();
    const token = randomBytes(LEADER_MEETING_SHARE_TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(this.clock.now().getTime() + LEADER_MEETING_SHARE_DAYS * TIME.MS_PER_DAY);
    const link = await this.links.create(ctx, {
      meetingId, tokenHash: tokenHashOf(token), expiresAt, revokedAt: null, revokedBy: null,
    } as never);
    await this.audit.record(ctx, {
      action: 'leader_meeting_share_link.created', targetCollection: LINKS, targetId: String(link._id),
      before: null, after: { meetingId, expiresAt: expiresAt.toISOString() },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** `DELETE /leader-meetings/:meetingId/share-links` — *Stop sharing*: every live link to the meeting, one audit row each. */
  async revokeAll(ctx: RequestContext, meetingId: string): Promise<{ revoked: number }> {
    await this.people.editor(ctx);
    if (!(await this.meetings.findById(ctx, meetingId))) throw meetingNotFound();
    const now = this.clock.now();
    let revoked = 0;
    for (const link of await this.links.liveFor(ctx, meetingId, now)) {
      // Revoked by somebody else a moment ago: theirs to record, not this one's.
      if (!(await this.links.revoke(ctx, String(link._id), now))) continue;
      revoked += 1;
      await this.audit.record(ctx, {
        action: 'leader_meeting_share_link.revoked', targetCollection: LINKS, targetId: String(link._id),
        before: { meetingId, expiresAt: link.expiresAt.toISOString() }, after: { revokedAt: now.toISOString() },
      });
    }
    return { revoked };
  }

  /**
   * `GET /leader-meetings/shared/:token`: the meeting read-only, by a live link of the reader's own office, or 404
   * — one answer for every failure. Each opening is one audit row: the reader, the meeting, the link.
   */
  async open(ctx: RequestContext, token: string): Promise<MeetingView> {
    await this.people.reader(ctx);
    const link = await this.links.findLive(ctx, tokenHashOf(token), this.clock.now());
    const meeting = link ? await this.meetings.findById(ctx, link.meetingId) : null;
    if (!link || !meeting) throw meetingNotFound();
    await this.audit.record(ctx, {
      action: 'leader_meeting_share_link.opened', targetCollection: LINKS, targetId: String(link._id),
      before: null, after: { meetingId: link.meetingId },
    });
    return this.forum.view(ctx, await this.people.office(ctx), meeting, 'link');
  }
}
