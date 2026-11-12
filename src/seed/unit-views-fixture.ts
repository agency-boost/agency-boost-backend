import mongoose from 'mongoose';
import { Group, GroupSchema } from '@/modules/org/group.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';

/**
 * **The Unit Dashboard's three views, on the demo** (P19.12-T6; the client's message of 11 November 2026, items 5 and 7;
 * ADR-0249; `functional/unit-dashboard.md`, *Views*, *Seed*).
 *
 * Wilson Tanoto, 0417's Owner and root AB, already holds what the views need: **every report of his is an AB** — Maya
 * (the Admin), Agus, Yosef and Satria (`demo.ts`, `reporting-fixture.ts`) — and he owns ***Top Producers 2026***, a live
 * group with **Agus tagged** (and Sari, an AAB under Agus) and the other three not. So, signed in as him:
 *
 * - ***Semua downline*** (his default): the whole office, every AB's tree under its AB, chips *1 langsung · 0 AAB · n AB*;
 * - ***Grup informal***: Wilson, Agus's own direct group and Sari — and the line ***"3 AB di bawah Anda belum masuk
 *   grup"*** with ***+ Tambah ke grup***, which tags Maya, Yosef or Satria into *Top Producers 2026*;
 * - ***Grup langsung***: himself alone — every report an AB — the empty unit, honestly.
 *
 * Agus (an AB with no AB below him) is offered *Grup langsung* alone and sees no picker. **This file writes nothing**: it
 * checks that the case stands — the group live, Agus in it, an AB below Wilson not — and composes the guide from what the
 * database holds, so a re-run, or a run after somebody tagged Yosef in the browser, says what is there.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The group `demo.ts` gives Wilson (`DEMO_GROUPS.topProducers`), named here rather than imported from `demo.ts`. */
const WILSON_GROUP = 'Top Producers 2026';

export interface UnitViewsFixtureDeps {
  kpmId: string;
  /** Wilson's membership. */
  owner: string;
}

export interface UnitViewsFixture {
  /** The live group Wilson owns, and the ABs below him in it and not. */
  group: { groupId: string; name: string } | null;
  tagged: string[];
  untagged: string[];
  guide: string;
}

export async function seedUnitViewsFixture(deps: UnitViewsFixtureDeps): Promise<UnitViewsFixture> {
  const Groups = mongoose.model(Group.name, GroupSchema, undefined, RECOMPILE);
  const Memberships = mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE);
  const Users = mongoose.model(User.name, UserSchema, undefined, RECOMPILE);

  const group = await Groups.findOne({
    kpmId: deps.kpmId, ownerMembershipId: deps.owner, name: WILSON_GROUP, status: 'active', deletedAt: null,
  }).lean().exec();
  const abs = await Memberships.find({
    kpmId: deps.kpmId, ancestorIds: deps.owner, role: 'ab', status: 'active', deletedAt: null,
  }).select('userId groupIds').lean().exec();
  const users = await Users.find({ _id: { $in: abs.map((m) => m.userId) } }).select('fullName').lean().exec();
  const nameOf = new Map(users.map((u) => [String(u._id), u.fullName]));
  const id = group ? String(group._id) : null;
  const first = (m: (typeof abs)[number]) => (nameOf.get(String(m.userId)) ?? '').split(' ')[0];
  const tagged = abs.filter((m) => id !== null && (m.groupIds ?? []).includes(id)).map(first).sort();
  const untagged = abs.filter((m) => id === null || !(m.groupIds ?? []).includes(id)).map(first).sort();

  const guide = `
  UNIT DASHBOARD VIEWS at /unit/dashboard  (P19.12-T6; src/seed/unit-views-fixture.ts)
    owner@kpm0417.test           Wilson — the picker beside "Bulan ini" on Overview and Potensi:
                                 Semua downline (his default) the whole office, chips 1 langsung · n AB;
                                 Grup informal  ${group ? `"${WILSON_GROUP}": ${tagged.join(', ') || 'no AB'} tagged` : 'no live group of his'}
                                                "${untagged.length} AB di bawah Anda belum masuk grup" (${untagged.join(', ') || 'none'})
                                                with + Tambah ke grup;
                                 Grup langsung  himself alone: every report of his is an AB.
                                 The choice is kept for the next visit (ab.unit.scope.{membership})
    agus@kpm0417.test            no AB below him: Grup langsung alone, no picker
    owner@kpm0417.test           /unit/dashboard/{Agus} opens on Grup langsung, read-only
`;
  return { group: group && id ? { groupId: id, name: group.name } : null, tagged, untagged, guide };
}
