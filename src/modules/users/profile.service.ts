import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { User, UserDocument } from './user.schema';

export interface ProfileFacts {
  companyName: string | null;
  agentCode: string | null;
  leader: { name: string; orgLevelCode: string } | null;
  group: { people: number; ab: number; aab: number; agents: number } | null;
}

/**
 * ***Profil saya*'s read-only facts** (UI V1, UI-111; `GET /auth/me/profile`): the insurer and the agent code sign-up
 * recorded — shown locked, *Tidak bisa diubah* — and *KPM dan peran*'s leader and group. What `GET /auth/me` already
 * carries (the office, the rung, *Core Leader*, the informal groups) is not repeated.
 *
 * **The reader's own, and nothing else**: the account is the session's (`ctx.userId`), the leader and the group are
 * read through the tenant-scoped membership repository and the coach resolver, so a leader in another office, or a
 * group member who left, is never counted. Somebody in no office yet reads their insurer and their code, with no leader
 * and no group.
 */
@Injectable()
export class ProfileService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    private readonly members: MembershipRepository,
    private readonly coaches: CoachResolver,
  ) {}

  async facts(ctx: RequestContext): Promise<ProfileFacts> {
    const user = await this.users.findOne({ _id: ctx.userId, deletedAt: null }).lean().exec();
    const company = user?.companyId
      ? await this.companies.findOne({ _id: user.companyId }).select('name').lean().exec()
      : null;
    return {
      companyName: company?.name ?? null,
      agentCode: user?.agentCode ?? null,
      leader: await this.leaderOf(ctx),
      group: await this.groupOf(ctx),
    };
  }

  /** *Leader Anda*: the reader's leader in this office, by name and rung, or `null`. */
  private async leaderOf(ctx: RequestContext): Promise<ProfileFacts['leader']> {
    if (!ctx.membershipId) return null;
    const mine = await this.members.findById(ctx, ctx.membershipId);
    if (!mine?.leaderId) return null;
    const leader = await this.members.findById(ctx, mine.leaderId);
    if (!leader) return null;
    const person = await this.users.findOne({ _id: leader.userId }).select('fullName').lean().exec();
    return person ? { name: person.fullName, orgLevelCode: leader.orgLevelCode } : null;
  }

  /** *Grup Anda*: everybody the reader leads, at any depth, counted by role; `null` for nobody. */
  private async groupOf(ctx: RequestContext): Promise<ProfileFacts['group']> {
    if (!ctx.membershipId) return null;
    const below = await this.coaches.coacheesOf(ctx, ctx.membershipId);
    if (below.length === 0) return null;
    const count = (role: string) => below.filter((c) => c.membership.role === role).length;
    return { people: below.length, ab: count('ab'), aab: count('aab'), agents: count('agent') };
  }
}
