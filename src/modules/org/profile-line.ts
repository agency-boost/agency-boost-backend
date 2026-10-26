import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { GroupRepository } from './org.repositories';

/**
 * **What the sidebar's profile line says about a member, after their role** (ADR-0159 §5, P18.8-T6 AC-1): the
 * names of the groups they are tagged with — the *Groups* of `/people/members`, live ones only, A to Z — and their
 * office, as its code and branch (*0417 · Cempaka Putih*). The *Core Leader* half is the context's own
 * (`RequestContext.isCoreLeader`), so it is not read again here.
 */
export interface ProfileLine {
  groups: string[];
  office: { code: string; branch: string } | null;
}

/** Nobody's office, no groups: what a session with no membership, or a harness without the reader, says. */
export const NO_PROFILE_LINE: ProfileLine = { groups: [], office: null };

const logger = new Logger('ProfileLine');

/**
 * **Read with `GET /auth/me`**, in two queries whatever the member: their live groups through the tenant-scoped
 * repository, and the office's own row by `_id` from the context — the scope is the id, as `ContextResolver` reads
 * it. A retired group stays on the membership (the record of a cohort) and is not named: the line says what the
 * person is in now.
 */
@Injectable()
export class ProfileLineReader {
  constructor(
    private readonly groups: GroupRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
  ) {}

  async read(ctx: RequestContext, groupIds: readonly string[]): Promise<ProfileLine> {
    if (!ctx.membership || !ctx.kpmId) return NO_PROFILE_LINE;
    const [groups, kpm] = await Promise.all([
      groupIds.length > 0
        ? this.groups.find(ctx, { _id: { $in: [...new Set(groupIds)] }, status: 'active' }, { sort: { name: 1 } })
        : Promise.resolve([]),
      this.kpms.findById(ctx.kpmId).select('code branchName').lean().exec(),
    ]);
    const office = kpm as { code?: string; branchName?: string } | null;
    return {
      groups: groups.map((g) => g.name),
      office: office?.code ? { code: office.code, branch: office.branchName ?? '' } : null,
    };
  }
}

/**
 * **Fails open to nothing** — no groups, no office — as the *New agent* facts do (`activationNavFor`): a session that
 * cannot name its reader's groups still loads, with the role alone on the line. It decides nothing anybody may do.
 */
export async function profileLineFor(
  reader: ProfileLineReader | null | undefined, ctx: RequestContext, groupIds: readonly string[],
): Promise<ProfileLine> {
  if (!reader || !ctx.membership) return NO_PROFILE_LINE;
  try {
    return await reader.read(ctx, groupIds);
  } catch (err) {
    logger.error({ err }, 'failed to read the profile line for the session');
    return NO_PROFILE_LINE;
  }
}
