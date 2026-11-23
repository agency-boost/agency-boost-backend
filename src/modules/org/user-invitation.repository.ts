import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { UserInvitation, UserInvitationDocument } from './user-invitation.schema';

/**
 * ***Tambah user*'s invitations** (P19.28-T1; ADR-0286 §2): read and written inside one KPM through the inherited scoped
 * methods — the Owner's or an Admin's own, the Super Admin's through a context naming the KPM.
 *
 * Two reads go past the KPM, by name (invariant §1), each the Super Admin's alone, each registered in
 * `named-cross-tenant-reads.tenancy.spec.ts`:
 *
 * - `listWaitingAcrossTenants` — Anggota's *Menunggu* across every KPM the filters name;
 * - `findByIdAcrossTenants` — *Kirim ulang* and *Batalkan* from Anggota, where the Super Admin is in no KPM.
 */
@Injectable()
export class UserInvitationRepository extends TenantScopedRepository<UserInvitationDocument> {
  constructor(@InjectModel(UserInvitation.name) model: Model<UserInvitationDocument>) {
    super(model, 'userInvitations');
  }

  /**
   * **Every waiting invitation of the KPMs named** — `pending`, expired ones included (they read *Diundang* until
   * resent or cancelled) — for Anggota's *Menunggu* (P19.28-T1 AC-5). The KPMs are **named**, never absent: `kpmId` is
   * written last, so nothing in `filter` can widen it. Soft-deleted rows stay out. Anybody but a Super Admin is refused
   * as an unscoped read is.
   */
  async listWaitingAcrossTenants(
    ctx: RequestContext,
    kpmIds: readonly string[],
    filter: FilterQuery<UserInvitationDocument> = {},
  ): Promise<UserInvitationDocument[]> {
    if (!ctx.isSuperAdmin) throw new MissingTenantContextError(this.collectionName, 'listWaitingAcrossTenants');
    if (kpmIds.length === 0) return [];
    return this.model
      .find({ ...filter, status: 'pending', kpmId: { $in: [...kpmIds] }, deletedAt: null } as FilterQuery<UserInvitationDocument>)
      .sort({ invitedAt: -1 })
      .exec();
  }

  /**
   * **One invitation by id, in whichever KPM holds it** — *Kirim ulang* and *Batalkan* on Anggota's row, where the Super
   * Admin is in no KPM. A malformed id is nothing found. Anybody but a Super Admin is refused.
   */
  async findByIdAcrossTenants(ctx: RequestContext, id: string): Promise<UserInvitationDocument | null> {
    if (!ctx.isSuperAdmin) throw new MissingTenantContextError(this.collectionName, 'findByIdAcrossTenants');
    if (!isValidObjectId(id)) return null;
    return this.model.findOne({ _id: id, deletedAt: null }).exec();
  }

  /**
   * **Write an invitation only while it is still waiting** — accepting, cancelling or a new link: of two taps at once,
   * exactly one matches. `true` when it matched.
   */
  async updateIfWaiting(ctx: RequestContext, id: string, set: Record<string, unknown>): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const result = await this.model
      .updateOne(
        this.scope(ctx, 'updateIfWaiting', { _id: id, status: 'pending' } as never),
        { $set: { ...set, updatedBy: ctx.membershipId } },
      )
      .exec();
    return result.matchedCount === 1;
  }

  /**
   * **Every waiting invitation for one account, in whichever KPM holds it, cancelled** — *Hapus akun* (P19.31-T1 AC-3;
   * ADR-0289 §2): the ones made for the account (`userId`) or to its address. The Super Admin's alone; answers the ids
   * cancelled, so a failed retirement can open them again (`reopenAcrossTenants`).
   */
  async cancelWaitingForAccountAcrossTenants(
    ctx: RequestContext, account: { userId: string; email: string }, set: Record<string, unknown>,
  ): Promise<string[]> {
    if (!ctx.isSuperAdmin) throw new MissingTenantContextError(this.collectionName, 'cancelWaitingForAccountAcrossTenants');
    const filter = {
      status: 'pending', deletedAt: null, $or: [{ userId: account.userId }, { email: account.email.toLowerCase() }],
    } as FilterQuery<UserInvitationDocument>;
    const ids = (await this.model.find(filter).select('_id').exec()).map((row) => String(row._id));
    if (ids.length === 0) return [];
    await this.model.updateMany({ _id: { $in: ids }, status: 'pending' }, { $set: { ...set, status: 'cancelled' } }).exec();
    return ids;
  }

  /** **The invitations a failed retirement cancelled, waiting again** (P19.31): by id, the Super Admin's alone. */
  async reopenAcrossTenants(ctx: RequestContext, ids: readonly string[]): Promise<void> {
    if (!ctx.isSuperAdmin) throw new MissingTenantContextError(this.collectionName, 'reopenAcrossTenants');
    if (ids.length === 0) return;
    await this.model.updateMany(
      { _id: { $in: [...ids] }, status: 'cancelled' },
      { $set: { status: 'pending', cancelledAt: null, cancelledByUserId: null } },
    ).exec();
  }
}
