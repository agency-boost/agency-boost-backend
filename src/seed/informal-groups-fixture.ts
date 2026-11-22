import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { addMonths } from '@/domain/metrics/ab-group-targets';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { AbGroupTarget, AbGroupTargetSchema } from '@/modules/reporting/ab-group-targets/ab-group-target.schema';

/**
 * **Informal groups on ABs, and the monthly targets per AB group, seeded** (P19.17-T4;
 * [ADR-0270](../../../docs/04-adr/0270-informal-groups-belong-to-abs-and-targets-are-set-per-ab-group-per-month.md);
 * `revisions/2026-11-19/BRIEF-ADJUSTMENTS-2026-11-19.md`, *Informal groups and Group Leaders*' example data).
 *
 * **Only ABs carry a group**; their AABs and agents follow. On 0417:
 *
 * | Group | ABs (each with their team) | Group Leaders |
 * |---|---|---|
 * | *Top Producers 2026* | Wilson (the Owner), Agus | Wilson |
 * | *Mentoring Agen Baru* | Satria | Satria |
 * | *LEADER MUDA* | none yet — an empty group | none |
 * | *Tanpa group* | Maya (the Admin), Yosef | — |
 *
 * So Wilson's Unit Dashboard *Grup informal* still names three ABs below him not in his group (Maya, Yosef, Satria).
 * **The targets**: Wilson 3 and 2, Agus 6 and 3, Satria 2 and 1 and Yosef 4 and 2, saved two months back and carried
 * since; Agus raised to 8 and 4 this month; **Maya none** — *Belum ada target*. The APE targets come from the cast's Goal
 * Setting, which the demo seeds already.
 *
 * **Converges**: an AB's tag is set, not added, and every other tag on the office's AABs and agents is cleared (they
 * follow their AB) — so a database seeded before P19.17 reads as a fresh one. A group is found by name, including the name
 * an earlier run gave it. **The targets are written once** (`$setOnInsert`), so a target somebody changed in the browser
 * survives a re-run.
 */

const RECOMPILE = { overwriteModels: true } as const;

export interface InformalGroupsFixtureDeps {
  clock: Clock;
  kpmId: string;
  /** The person who made the groups: the Owner. */
  createdBy: string;
  wilson: string;
  agus: string;
  satria: string;
  maya: string;
  yosef: string;
  groups: {
    topProducers: { name: string };
    mentoring: { name: string; formerly?: string };
    leaderMuda: { name: string };
  };
}

export interface InformalGroupsFixture {
  groupIds: { topProducers: string; mentoring: string; leaderMuda: string };
  targetsWritten: number;
  guide: string;
}

export async function seedInformalGroupsFixture(deps: InformalGroupsFixtureDeps): Promise<InformalGroupsFixture> {
  const Groups = mongoose.model(Group.name, GroupSchema, undefined, RECOMPILE);
  const Memberships = mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE);
  const Targets = mongoose.model(AbGroupTarget.name, AbGroupTargetSchema, undefined, RECOMPILE);

  const plan = [
    { key: 'topProducers', ...deps.groups.topProducers, abs: [deps.wilson, deps.agus], leaders: [deps.wilson] },
    { key: 'mentoring', ...deps.groups.mentoring, abs: [deps.satria], leaders: [deps.satria] },
    { key: 'leaderMuda', ...deps.groups.leaderMuda, abs: [] as string[], leaders: [] as string[] },
  ] as const;

  // Everybody but an AB follows their AB: the tags P3-T9 let an AAB or an agent carry are cleared.
  await Memberships.updateMany(
    { kpmId: deps.kpmId, role: { $ne: 'ab' }, 'groupIds.0': { $exists: true } }, { $set: { groupIds: [] } },
  ).exec();
  await Memberships.updateMany({ _id: { $in: [deps.maya, deps.yosef] } }, { $set: { groupIds: [] } }).exec();

  const groupIds = {} as InformalGroupsFixture['groupIds'];
  for (const seed of plan) {
    const names = 'formerly' in seed && seed.formerly ? [seed.name, seed.formerly] : [seed.name];
    const existing = await Groups.findOne({ kpmId: deps.kpmId, name: { $in: names }, status: 'active', deletedAt: null }).exec();
    const group = existing ?? await Groups.create({
      kpmId: deps.kpmId, name: seed.name, leaderMembershipIds: [], status: 'active', createdByMembershipId: deps.createdBy,
    });
    const id = String(group._id);
    await Groups.updateOne(
      { _id: group._id }, { $set: { name: seed.name, leaderMembershipIds: [...seed.leaders] }, $unset: { ownerMembershipId: '' } },
    ).exec();
    if (seed.abs.length > 0) await Memberships.updateMany({ _id: { $in: [...seed.abs] } }, { $set: { groupIds: [id] } }).exec();
    groupIds[seed.key] = id;
  }

  const month = deps.clock.localDateFor(DEFAULT_TENANT_TIMEZONE).slice(0, 7);
  const twoBack = addMonths(month, -2);
  const targets: [ab: string, month: string, activeAgentTarget: number, rekrutTarget: number][] = [
    [deps.wilson, twoBack, 3, 2], [deps.agus, twoBack, 6, 3], [deps.satria, twoBack, 2, 1], [deps.yosef, twoBack, 4, 2],
    [deps.agus, month, 8, 4],
  ];
  let targetsWritten = 0;
  for (const [abMembershipId, m, activeAgentTarget, rekrutTarget] of targets) {
    const written = await Targets.updateOne(
      { kpmId: deps.kpmId, abMembershipId, month: m, deletedAt: null },
      {
        $setOnInsert: {
          kpmId: deps.kpmId, abMembershipId, month: m, activeAgentTarget, rekrutTarget, source: 'set',
          deletedAt: null, createdBy: deps.createdBy, updatedBy: deps.createdBy,
        },
      },
      { upsert: true },
    ).exec();
    targetsWritten += written.upsertedCount;
  }

  const guide = `
  INFORMAL GROUPS AND TARGETS (P19.17-T4; src/seed/informal-groups-fixture.ts)
    Only ABs carry a group; their AABs and agents follow.
      ${deps.groups.topProducers.name}: Wilson (Group Leader), Agus — and their teams
      ${deps.groups.mentoring.name}: Satria (Group Leader) and his team
      ${deps.groups.leaderMuda.name}: empty, no Group Leader yet
      Tanpa group: Maya, Yosef
    Monthly targets per AB group (Active Agent / Rekrut): Wilson 3/2, Agus 6/3 then 8/4 in ${month}, Satria 2/1,
    Yosef 4/2 from ${twoBack}; Maya none (Belum ada target). APE target = Goal Setting ÷ 12.
`;
  return { groupIds, targetsWritten, guide };
}
