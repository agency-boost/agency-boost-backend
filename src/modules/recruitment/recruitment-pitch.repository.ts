import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import type { RecruitmentPitchSlotCode } from '@/domain/constants';
import { RecruitmentPitchSlot, RecruitmentPitchSlotDocument } from './recruitment-pitch.schema';

/** The file an attach writes to a slot: what storage reported for it, and who attached it when. */
export interface AttachedFile {
  storageKey: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  uploadedAt: Date;
  uploadedByMembershipId: string | null;
}

/**
 * **An office's six pitch slots, behind the chokepoint** (invariant §1): every filter and every write
 * carries the reader's own `kpmId`, so an office never reads or writes another's slot — a slot of another
 * office is simply not found.
 */
@Injectable()
export class RecruitmentPitchRepository extends TenantScopedRepository<RecruitmentPitchSlotDocument> {
  constructor(@InjectModel(RecruitmentPitchSlot.name) model: Model<RecruitmentPitchSlotDocument>) {
    super(model, 'kpmRecruitmentPitchDocuments');
  }

  /**
   * **Attach a file to a slot, replacing what it held, and clear every confirmation — in one write**
   * (D-replace, exit criterion 1). The row is created by the first attach; `version` moves by one either
   * way. Answers the row **as it was** (`null` for a slot that held nothing), so the caller can release the
   * old file and name the ticks it cleared without a read that another write could slip between — and
   * whether the write **swapped** the file at all.
   *
   * - **The file the slot already holds is not written again** (`storageKey: { $ne }` in the filter): no
   *   version, no cleared ticks, and the caller retains nothing — `swapped: false`.
   * - **Two first attaches at once.** Both find the slot empty and upsert; the partial unique index on
   *   `(kpmId, slot)` refuses the second (`E11000`), which is then **retried once as an update** — the later
   *   file replaces the earlier, as two attaches one after the other would. The same refusal is also what an
   *   attach of the key the slot holds meets (the `$ne` filter excludes the row, and the upsert collides),
   *   told apart by reading the slot.
   */
  async attach(
    ctx: RequestContext, slot: RecruitmentPitchSlotCode, file: AttachedFile,
  ): Promise<{ previous: RecruitmentPitchSlotDocument | null; swapped: boolean }> {
    const filter = this.scope(ctx, 'attach', { slot, storageKey: { $ne: file.storageKey } });
    const write = () => this.model.findOneAndUpdate(
      filter,
      {
        $set: { ...file, confirmations: [], updatedBy: ctx.membershipId },
        $inc: { version: 1 },
        $setOnInsert: { createdBy: ctx.membershipId },
      },
      { new: false, upsert: true },
    ).exec();
    try {
      return { previous: await write(), swapped: true };
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const now = await this.findOne(ctx, { slot });
      if (now?.storageKey === file.storageKey) return { previous: now, swapped: false };
      return { previous: await write(), swapped: true };
    }
  }

  /**
   * **Tick or untick one item, pinned to the slot's version** (D-replace, T4 AC-4). `null` when the slot
   * is not at `version` any more — replaced since — or the item is already as asked, which the caller tells
   * apart by reading the slot again. A tick pushes `{ item, byMembershipId, at }` once; an untick pulls it.
   * The version does not move: it tracks the file, not the ticks.
   */
  async setConfirmation(
    ctx: RequestContext,
    slot: RecruitmentPitchSlotCode,
    version: number,
    item: string,
    tick: { byMembershipId: string; at: Date } | null,
  ): Promise<RecruitmentPitchSlotDocument | null> {
    const filter = this.scope(ctx, 'setConfirmation', {
      slot,
      version,
      'confirmations.item': tick ? { $ne: item } : item,
    });
    const update = tick
      ? { $push: { confirmations: { item, ...tick } } }
      : { $pull: { confirmations: { item } } };
    return this.model.findOneAndUpdate(
      filter,
      { ...update, $set: { updatedBy: ctx.membershipId } },
      { new: true },
    ).exec();
  }
}
