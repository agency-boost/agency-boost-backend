import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { ActivationProgress, ActivationProgressSchema } from '@/modules/activation/activation-progress.schema';
import { freshItemState } from '@/modules/activation/activation-rules';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { seedObjectId } from './coaching-fixture';
import { markNewHires } from './join-dates';

/**
 * **The whole office, for its Owner: something behind *Recruitment · {Bln}*** (P19.18; ADR-0271 §3, §7, §8;
 * `functional/unit-dashboard.md`, *Seed*).
 *
 * The rest of what Phase 19.18 draws is seeded already: Wilson's office of ABs (`demo.ts`, `reporting-fixture.ts`), the
 * month's production file that shows a policy for nearly everybody — *Active Agent* and its sheet — the coaching cast's
 * 1:1s of every age — the coaching status tile red, green and yellow — and the recruit leads switched on for the month
 * (`potensi-fixture.ts`) — the *Rekrut* view's orange numbers. **Nobody had joined this month**, so *Recruitment* and the
 * *Rekrut* view's green numbers read 0 on every day of the month. This places two new hires under **Maya Halim** (the
 * Admin, an AB), **registered by her** (`registeredByMembershipId`, ADR-0267 §3), each with a join date inside the
 * office's current month on the day the seed first runs — so, signed in as `owner@kpm0417.test`:
 *
 * - *Unit Dashboard › Overview*, *Semua downline*: ***Recruitment · {Bln} 2***, its sheet *"Direkrut oleh MAYA HALIM ·
 *   Bergabung …"* and *Lihat di New Hires*; *Unit MAYA HALIM · 3 orang*;
 * - *Potensi › Rekrut*: Maya's **green 2**; the tile *Rekrut 2 · potensi n*.
 *
 * Under Maya, not Agus, so Agus's roster — which the other fixtures' guides and specs count — is unchanged.
 *
 * **Each is a new hire as the product makes one** (ADR-0169 §2, §3): a placement under a leader in an office with a
 * published checklist starts an activation on the join date (`ActivationProgressService.joined`), so each is given one
 * here — origin `joined`, pinned to 0417's published checklist, nothing ticked — and is marked a new hire from its start
 * (`markNewHires`), as every other fixture's new hire is; migration 0040 then finds nothing to do on the seed.
 *
 * **Written once, until `--reset`**: `demo.ts`'s account and placement writers find what they made before, and the
 * activation carries an `_id` from `seedObjectId` and is written only while the member has none. **The join date is the
 * first run's** and is never moved after, as an activation's start never is (the seed's other people age with their data
 * too): a run in a later month without `--reset` shows them in the month they joined.
 */

const RECOMPILE = { overwriteModels: true } as const;

export const WHOLE_OFFICE_SEED = {
  hilmy: { email: 'hilmy@kpm0417.test', fullName: 'Hilmy Ramadhan', agentCode: '88961', pronoun: 'he' },
  // Not *Putri Anggraini*: she is `pending@kpm0417.test`, waiting on Sari (`joining-fixture.ts`) — one name, one person.
  zahra: { email: 'zahra@kpm0417.test', fullName: 'Zahra Febriani', agentCode: '88962', pronoun: 'she' },
} as const;

export interface WholeOfficeFixtureDeps {
  clock: Clock;
  /** Maya Halim's membership in 0417: the recruiter. */
  maya: string;
  /** `demo.ts`'s own account writer: an address it made before is found, and nothing is written. */
  user: (email: string, fullName: string, opts: { agentCode: string; pronoun: 'he' | 'she' }) => Promise<{ _id: unknown }>;
  /** Places an account as an agent under Maya, joined `daysAgo` days ago; a membership made before is found. */
  place: (userId: string, daysAgo: number) => Promise<{ id: string }>;
}

export interface WholeOfficeFixture {
  membershipIds: string[];
  /** Their join dates, office days: the current month's on the run that placed them. */
  joinDates: string[];
  guide: string;
}

export async function seedWholeOfficeFixture(deps: WholeOfficeFixtureDeps): Promise<WholeOfficeFixture> {
  const db = mongoose.connection.db!;
  const Memberships = mongoose.model(Membership.name, MembershipSchema, undefined, RECOMPILE);
  const Rows = mongoose.model(ActivationProgress.name, ActivationProgressSchema, undefined, RECOMPILE);
  const tz = DEFAULT_TENANT_TIMEZONE;
  const today = deps.clock.localDateFor(tz, deps.clock.now());
  const dayOfMonth = Number(today.slice(8, 10));
  // Inside this month on every day of it: two and four days ago when the month allows, else its 1st.
  const backs = [Math.min(2, dayOfMonth - 1), Math.min(4, dayOfMonth - 1)];
  const membershipIds: string[] = [];
  const joinDates: string[] = [];

  for (const [i, seed] of Object.values(WHOLE_OFFICE_SEED).entries()) {
    const account = await deps.user(seed.email, seed.fullName, { agentCode: seed.agentCode, pronoun: seed.pronoun });
    // `place()` writes the join — `joinedAt`, the `joined` edge and the join date — once, on the run that places them.
    const placed = await deps.place(String(account._id), backs[i]);
    const _id = new mongoose.Types.ObjectId(placed.id);
    // Registered by Maya (ADR-0267 §3), and a real person: `RECRUITS_JOINED` counts them.
    await Memberships.collection.updateOne({ _id }, { $set: { registeredByMembershipId: deps.maya, testAccount: false } });
    const member = (await Memberships.collection.findOne({ _id }))!;
    const kpmId = member.kpmId as string;

    // The activation the placement starts (ADR-0103, ADR-0169 §2): from the join date, pinned to the published checklist.
    if (!(await db.collection('activationProgress').findOne({ kpmId, membershipId: placed.id, deletedAt: null }))) {
      const checklist = await db.collection('activationTemplates')
        .find({ kpmId, status: 'published', deletedAt: null }).sort({ version: -1 }).limit(1).next();
      if (!checklist) throw new Error(`KPM ${kpmId} has no published activation checklist for the whole-office fixture`);
      const items = (checklist.aspects as { items: { code: string }[] }[]).flatMap((a) => a.items);
      const startDate = (member.joinDate as string | null) ?? deps.clock.localDateFor(tz, member.joinedAt as Date);
      const rowId = new mongoose.Types.ObjectId(seedObjectId('whole-office-fixture', 'activation', kpmId, placed.id));
      const doc = new Rows({
        _id: rowId, kpmId, membershipId: placed.id, templateId: String(checklist._id),
        templateVersion: checklist.version as number, startDate, startCorrectedAt: null, startCorrectedByMembershipId: null,
        origin: 'joined', items: items.map((item) => freshItemState(item.code)), note: null, graduatedAt: null,
        graduatedByMembershipId: null, version: 1, deletedAt: null, createdBy: null, updatedBy: null,
      }, null, { strict: 'throw' });
      await doc.validate();
      const at = (member.joinedAt as Date | null) ?? deps.clock.now();
      await Rows.collection.insertOne({ ...doc.toObject(), _id: rowId, createdAt: at, updatedAt: at });
    }
    // ADR-0169: a new hire, joined on their activation's start.
    await markNewHires([placed.id]);
    membershipIds.push(placed.id);
    joinDates.push(((await Memberships.collection.findOne({ _id }))!.joinDate as string));
  }

  const guide = `
  THE WHOLE OFFICE at /unit/dashboard, / and /coaching  (P19.18; src/seed/whole-office-fixture.ts)
    owner@kpm0417.test   Unit Dashboard opens on Tahun ini and Semua downline: one orange panel, Tim Anda, Active Agent
                         and Recruitment · this month (${WHOLE_OFFICE_SEED.hilmy.fullName} and ${WHOLE_OFFICE_SEED.zahra.fullName},
                         joined ${joinDates.join(' and ')}, "Direkrut oleh MAYA HALIM"); tap a person: the card first.
                         Potensi › Rekrut: Maya's green 2. Home: Active Agent and Coaching 7 hari "x dari N" over the
                         office, Laporan aktivitas tim by unit with Semua downline ⌄. Coaching: the office by unit.
    admin@kpm0417.test   the same whole office (an Admin is the Owner but for admins).
    hilmy@ · zahra@kpm0417.test  new hires of this month: /activation open from their join date, nothing ticked yet.
    agus@kpm0417.test    his own team: Grup langsung beside Direct Unit; tap a person: straight to their Summary.
`;
  return { membershipIds, joinDates, guide };
}
