import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { localDayOf } from '@/common/time/local-day';
import {
  RECRUITMENT, RECRUITMENT_PITCH_SLOTS, recruitmentPitchState, recruitmentPitchSummary,
  type RecruitmentPitchSlotCode, type RecruitmentPitchState, type RecruitmentPitchSummary,
} from '@/domain/constants';
import { AssetService } from '@/modules/assets/asset.service';
import type { SignedUpload } from '@/modules/assets/storage.port';
import { AuditService } from '@/modules/audit/audit.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { RecruitmentPitchRepository } from './recruitment-pitch.repository';
import type { RecruitmentPitchSlotDocument } from './recruitment-pitch.schema';
import { pitchItemLabel, pitchSlotLine, pitchSlotTitle, RECRUITMENT_REFUSALS } from './recruitment.messages';

/** One of the six slots, as both the agents' tab and the settings page read it (`PitchSlot`). */
export interface PitchSlotView {
  slot: RecruitmentPitchSlotCode;
  title: string;
  line: string;
  /** `true` for the four the readiness counts; `false` for *Company Profile* and *Agency Profile* (ADR-0177). */
  required: boolean;
  state: RecruitmentPitchState;
  /**
   * `null`, never a placeholder, where the slot holds nothing (T4 AC-5). `mimeType` is what storage holds: a PDF, or an
   * HTML page that a reader draws only in the sandboxed frame (P19.6-T2, ADR-0217 §4).
   */
  file: { name: string; bytes: number; uploadedOn: string; mimeType: string } | null;
  /** `[]` for a slot with no checklist. Whether each item is ticked — never by whom. */
  checklist: { code: string; label: string; ticked: boolean }[];
  /** `0` while the slot has never held a file. */
  version: number;
}

/** `GET /recruitment/pitch-materials` (`PitchMaterialsView`). */
export interface PitchMaterialsView {
  slots: PitchSlotView[];
  /**
   * Over the four required slots alone (`recruitmentPitchSummary`, ADR-0177 §3): `done` complete or uploaded;
   * `missing` no file; `unconfirmed` a file with an item open (`:797-820`).
   */
  summary: RecruitmentPitchSummary;
}

type SlotDefinition = (typeof RECRUITMENT_PITCH_SLOTS)[number];

const PITCH = 'kpmRecruitmentPitchDocuments';

/**
 * **The office's recruitment pitch documents** (D-model, D-slots, D-replace, D-api; P17-T4; ADR-0177): the
 * four the readiness counts, then *Company Profile* and *Agency Profile*, optional.
 *
 * The office's own files (ADR-0032), each in its own slot, through the tenant-scoped repository: an office
 * reads and writes its own six and no other's, and another office's slot or file is **404**, never 403. An
 * optional slot is uploaded, replaced and opened exactly as a required one is; only the banner tells them apart.
 *
 * - **The read** (`recruitment:read`, every member of the office) — the six slots in order, each with whether
 *   it is required, its state by the one completion rule, its file's name, size and upload day in the office's
 *   calendar, and whether each item is ticked; and the banner's counts, over the four required. The agents'
 *   tab and the settings page read the same answer.
 * - **The link** — signed for 300 seconds, only for a slot the reader's own office has filled.
 * - **The writes** (`tenant_config:write`, the Owner and the Admin) — a signed upload of a PDF into the
 *   office's own `recruitment-pitch` folder; attaching it to a slot, which **clears every confirmation of
 *   the slot in the same write**, releases (never deletes) the file it replaces and moves `version`; and
 *   ticking an item, pinned to that version. Every write is audited; nothing notifies.
 */
@Injectable()
export class RecruitmentPitchService {
  constructor(
    private readonly slots: RecruitmentPitchRepository,
    private readonly assets: AssetService,
    private readonly audit: AuditService,
    private readonly offices: TenantDay,
    private readonly clock: Clock,
  ) {}

  /** `GET /recruitment/pitch-materials`: the six slots, in order, and the banner's counts over the four required. */
  async read(ctx: RequestContext): Promise<PitchMaterialsView> {
    this.requireOffice(ctx, 'read');
    const [rows, timezone] = await Promise.all([this.slots.find(ctx), this.offices.timezoneOf(ctx)]);
    const views = RECRUITMENT_PITCH_SLOTS.map((definition) =>
      this.view(definition, rows.find((row) => row.slot === definition.code) ?? null, timezone, ctx.reader));
    return { slots: views, summary: recruitmentPitchSummary(views) };
  }

  /**
   * `GET /recruitment/pitch-materials/:slot/url` (T4 AC-6, exit criterion 2): a link valid 300 seconds to
   * the file the reader's own office holds in the slot. A slot not filled, a slot that does not exist and
   * another office's are all **404**, said the same way.
   */
  async url(ctx: RequestContext, slotCode: string): Promise<{ url: string; expiresAt: string }> {
    this.requireOffice(ctx, 'url');
    const definition = this.requireSlot(slotCode);
    const row = await this.slots.findOne(ctx, { slot: definition.code });
    if (!row) throw new NotFoundException('Document');
    const url = await this.assets.urlFor(ctx, row.storageKey);
    const expiresAt = new Date(this.clock.now().getTime() + RECRUITMENT.LINK_TTL_SECONDS * 1000);
    return { url, expiresAt: expiresAt.toISOString() };
  }

  /**
   * `POST /kpm/settings/recruitment-pitch/uploads` (T4 AC-2): a signed upload into the office's own
   * `recruitment-pitch` folder — **a PDF or an HTML page (P19.6-T2, ADR-0217 §1) of at most 25 MB**, refused before
   * the signature otherwise (`ASSET_TYPE_NOT_ALLOWED`, `ASSET_TOO_LARGE`).
   */
  async requestUpload(
    ctx: RequestContext, params: { filename: string; mimeType: string; bytes: number },
  ): Promise<SignedUpload> {
    return this.assets.requestUpload(
      ctx, { folder: RECRUITMENT.PITCH_UPLOAD_FOLDER, ...params }, RECRUITMENT.PITCH_MIME_TYPES,
    );
  }

  /**
   * `PUT /kpm/settings/recruitment-pitch/:slot` (T4 AC-2, AC-3; D-replace — exit criterion 1).
   *
   * The upload is **confirmed against storage first** (ADR-0040): another office's key, or one nobody
   * signed, is 404; bytes that never arrived are `409 ASSET_NOT_UPLOADED`; a file storage reports as
   * anything but a PDF, or larger than 25 MB, is refused — and in every case nothing is attached. Then,
   * **in one write**, the file replaces whatever the slot held, **every confirmation of the slot is
   * cleared**, and `version` moves by one; the file it replaced is **released, never deleted**. One audit
   * entry names the slot, the file and the items it cleared. Attaching the key the slot already holds
   * changes nothing.
   */
  async attach(ctx: RequestContext, slotCode: string, storageKey: string): Promise<PitchSlotView> {
    this.requireOffice(ctx, 'attach');
    const definition = this.requireSlot(slotCode);
    const current = await this.slots.findOne(ctx, { slot: definition.code });
    if (current?.storageKey === storageKey) {
      return this.view(definition, current, await this.offices.timezoneOf(ctx), ctx.reader);
    }

    const asset = await this.assets.confirmUpload(ctx, storageKey, RECRUITMENT.PITCH_MIME_TYPES);
    const file = {
      storageKey: asset.storageKey,
      // A file with no name of its own takes its slot's title, in the language of whoever uploads it (P18.10-T7).
      fileName: asset.originalFilename ?? render(pitchSlotTitle(definition.code), ctx.reader),
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      uploadedAt: this.clock.now(),
      uploadedByMembershipId: ctx.membershipId,
    };
    const { previous, swapped } = await this.slots.attach(ctx, definition.code, file);
    const row = (await this.slots.findOne(ctx, { slot: definition.code }))!;
    // Another attach of this very file got there between the read above and this write: nothing changed.
    if (!swapped) return this.view(definition, row, await this.offices.timezoneOf(ctx), ctx.reader);

    // Referenced once more only by a write that swapped the file in; the one it replaced, once less.
    await this.assets.retain(ctx, asset.storageKey);
    if (previous) await this.assets.release(ctx, previous.storageKey);

    const cleared = (previous?.confirmations ?? []).map((c) => c.item);
    await this.audit.record(ctx, {
      action: 'recruitment_pitch.attached',
      targetCollection: PITCH,
      targetId: String(row._id),
      before: previous
        ? { storageKey: previous.storageKey, fileName: previous.fileName, version: previous.version, confirmed: cleared }
        : null,
      // What this write wrote — the version the one it replaced held, plus one — never a re-read, which a later
      // write could already have moved.
      after: {
        slot: definition.code, storageKey: asset.storageKey, fileName: file.fileName, bytes: file.bytes,
        version: (previous?.version ?? 0) + 1, clearedItems: cleared,
      },
    });
    return this.view(definition, row, await this.offices.timezoneOf(ctx), ctx.reader);
  }

  /**
   * `PUT /kpm/settings/recruitment-pitch/:slot/confirmations/:item` (T4 AC-4): tick or untick one item of
   * the slot's own checklist, **pinned to the slot's version** — one sent against a file replaced since is
   * `409 VERSION_CONFLICT` with nothing written. Idempotent: an item already as asked changes nothing. An
   * item the slot does not have, or a slot with no file, is `400`; a slot that does not exist is `404`.
   * Audited with who and when; the version does not move.
   */
  async confirm(
    ctx: RequestContext, slotCode: string, itemCode: string, input: { ticked: boolean; version: number },
  ): Promise<PitchSlotView> {
    this.requireOffice(ctx, 'confirm');
    const definition = this.requireSlot(slotCode);
    const item = (definition.checklist as readonly { code: string }[]).find((i) => i.code === itemCode);
    if (!item) {
      const title = pitchSlotTitle(definition.code);
      throw invalid(RECRUITMENT_REFUSALS.VALIDATION_FAILED.noSuchItem({ title, item: itemCode }), {
        field: 'item', item: itemCode,
      });
    }
    const current = await this.slots.findOne(ctx, { slot: definition.code });
    if (!current) {
      throw invalid(RECRUITMENT_REFUSALS.VALIDATION_FAILED.noFileYet({ title: pitchSlotTitle(definition.code) }), {
        field: 'slot', slot: definition.code,
      });
    }
    if (current.version !== input.version) throw new VersionConflictException(input.version, current.version);

    const at = this.clock.now();
    const written = await this.slots.setConfirmation(
      ctx, definition.code, input.version, item.code,
      input.ticked ? { byMembershipId: ctx.membershipId!, at } : null,
    );
    const timezone = await this.offices.timezoneOf(ctx);
    if (!written) {
      // Either it was already as asked — nothing to write — or the file was replaced between the read and
      // the write, which the version says.
      const now = (await this.slots.findOne(ctx, { slot: definition.code }))!;
      if (now.version !== input.version) throw new VersionConflictException(input.version, now.version);
      return this.view(definition, now, timezone, ctx.reader);
    }
    await this.audit.record(ctx, {
      action: input.ticked ? 'recruitment_pitch.ticked' : 'recruitment_pitch.unticked',
      targetCollection: PITCH,
      targetId: String(written._id),
      after: { slot: definition.code, item: item.code, ticked: input.ticked, version: written.version, at: at.toISOString() },
    });
    return this.view(definition, written, timezone, ctx.reader);
  }

  // -------------------------------------------------------------------- internals

  /** A Super Admin outside a support session belongs to no office: refused as every scoped read is. */
  private requireOffice(ctx: RequestContext, operation: string): void {
    if (!ctx.kpmId) throw new MissingTenantContextError(PITCH, operation);
  }

  /** One of the six, or 404: a slot that does not exist is not found, as an empty one's link is. */
  private requireSlot(code: string): SlotDefinition {
    const definition = RECRUITMENT_PITCH_SLOTS.find((s) => s.code === code);
    if (!definition) throw new NotFoundException('Document');
    return definition;
  }

  /**
   * One slot, **its words written for the reader** (P18.10-T7; ADR-0179 §7): the title, the line and each checklist
   * item's label are the platform's, served in the reader's language — the codes, the file's own name and the rest as
   * they are.
   */
  private view(
    definition: SlotDefinition, row: RecruitmentPitchSlotDocument | null, timezone: string, reader: Reader,
  ): PitchSlotView {
    const ticked = new Set((row?.confirmations ?? []).map((c) => c.item));
    const checklist = definition.checklist.map(({ code }) => ({
      code, label: render(pitchItemLabel(code), reader), ticked: ticked.has(code),
    }));
    return {
      slot: definition.code,
      title: render(pitchSlotTitle(definition.code), reader),
      line: render(pitchSlotLine(definition.code), reader),
      required: definition.required,
      state: recruitmentPitchState(row !== null, checklist),
      file: row ? {
        name: row.fileName, bytes: row.bytes, uploadedOn: localDayOf(row.uploadedAt, timezone), mimeType: row.mimeType,
      } : null,
      checklist,
      version: row?.version ?? 0,
    };
  }
}

function invalid(message: Sentence<'VALIDATION_FAILED'>, details: Record<string, unknown>): DomainException {
  return new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
}
