import { Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { LocalDate } from '@/common/time/local-day';
import { AuditService } from './audit.service';

/**
 * Where another member's data was read from, as the entry's `after.surface` names it.
 *
 * P10.1-T7's three; `personal_summary`: `GET /summary?for=`, a leader's copy of the coachee's
 * Personal Summary (P11-T4 AC-5); and `leads`: `GET /leads`, a leader's list holding a downline's
 * rows, one entry per owner shown (OD-107), which `GET /leads?owner=` writes too, once per read, and
 * `GET /leads/:id` of a lead the caller does not own, once;
 * `ratios`: `GET /activity/ratios?for=`, the session's Ratios card (P11-T4 AC-5); `coaching_session`:
 * `GET /coaching/sessions/:sessionId` and the answers of *Start*, finalize and reopen (P11-T5);
 * `coaching_session_print`: `GET /coaching/sessions/:sessionId/print`, the version printed (P11-T10,
 * ADR-0077; `functional/coaching.md`, *Audit and privacy*); `calendar`: `GET /calendar/entries?for=`, a
 * leader's compared pane of a downline's week, one per read (P12-T5 AC-5, D-audit, ADR-0093). The action
 * keeps its name on every one, so a single query on `targetMembershipId` lists every disclosure of a
 * member's data.
 */
export type SubjectReadSurface =
  | 'log' | 'summary' | 'compliance' | 'personal_summary' | 'leads' | 'ratios' | 'coaching_session'
  | 'coaching_session_print' | 'calendar';

/** The action every subject read writes, whichever surface it came from. */
export const SUBJECT_READ_ACTION = 'activity_log.read_raw';

/**
 * **Every read of another member's data leaves a record** — `roles-and-permissions.md` §3.5,
 * obligation 1 — written here and nowhere else (P11-T3 AC-8).
 *
 * P10.1-T7 wrote it as `ActivityService`'s private `auditRawRead`. Coaching reads the same member's
 * data from four more modules, and a copy per module is how one of them would come to record a
 * different shape, or forget the self-read rule. So the seam is one injectable, and any module
 * holding a subject read calls it.
 *
 * - **The entry**: the actor (`AuditService.record` adds them, and both people under
 *   impersonation), the subject as `targetMembershipId`, the range and the surface.
 * - **Reading yourself writes nothing.** Under impersonation the session is the record.
 * - **Called last, once the answer exists**, by the caller: a refused read has thrown before it,
 *   so the log says what was disclosed, never what was asked for.
 * - **It fails open** (the phase file's D-failopen): a read whose entry cannot be written is still
 *   served, and the failure is logged at error level, where Phase 19's alert will read it.
 *   `AuditService.record` already catches its own write; this catches anything else, so the
 *   guarantee belongs to the seam rather than to how the service under it happens to be written.
 */
@Injectable()
export class SubjectReadAudit {
  private readonly logger = new Logger(SubjectReadAudit.name);

  constructor(private readonly audit: AuditService) {}

  async record(
    ctx: RequestContext,
    subject: { membershipId: string },
    surface: SubjectReadSurface,
    range: { from: LocalDate | null; to: LocalDate },
  ): Promise<void> {
    if (subject.membershipId === ctx.membershipId) return;
    try {
      await this.audit.record(ctx, {
        action: SUBJECT_READ_ACTION,
        targetCollection: 'memberships',
        targetId: subject.membershipId,
        targetMembershipId: subject.membershipId,
        after: { surface, from: range.from, to: range.to },
      });
    } catch (err) {
      this.logger.error({ err, action: SUBJECT_READ_ACTION, surface }, 'failed to write audit entry');
    }
  }
}
