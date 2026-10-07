import { DateTime } from 'luxon';
import type mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE, MINOR_UNITS_PER_MAJOR } from '@/domain/constants';
import type { KpmSubscription } from '@/modules/tenants/kpm.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **Subscriptions and the leader limit, seeded** (Phase 13.2, *Seed*; ADR-0112, ADR-0113).
 *
 * Which account shows what — every field account on `"demo password field"`:
 *
 * | Office | Its subscription | Who to sign in as, and what they see |
 * |---|---|---|
 * | **0417** BSD City | ends **three months** after the seed's today; Rp 350,000 a leader; at most **10** leaders, **6** used (the Owner, the Admin, Agus, Sari, Dewi and Arief) | `superadmin@agencyboost.test` at `/admin/tenants`: the row reads *6 / 10*, its end date three months on |
 * | **0555** Kelapa Gading | ends **five days** after today; Rp 400,000 a leader; **no limit** | the list's near end: *Active*, its end five days away, *2* leaders |
 * | **0601** Cikarang (new) | **ended ten days ago**, not kept active | `owner@kpm0601.test` and `agent@kpm0601.test`: the page saying the subscription ended and to contact AgencyBoost, at whatever address they open. The list reads *Ended* |
 * | **0602** Bekasi Barat (new) | **ended three days ago, kept active**; at its limit of **2** leaders (the Owner and Sinta, an AAB) | `owner@kpm0602.test`: everything works; at `/people/members`, promoting Joko (Agent) to AAB is refused with the limit's words. The list reads *Ended — kept active* and *2 / 2* |
 *
 * **Dates count from the run's today in `Asia/Jakarta`**, through the clock port. **Written only where
 * missing**: an office's subscription is set when it has none, offices are found by their derived ids,
 * and people by their address — so a re-seed without `--reset` writes nothing, and a subscription edited
 * in a walk is left as the walk left it. Office 0417's and 0555's configuration are other fixtures'; only
 * their subscriptions are this one's.
 */

/** The password every account below signs in with: the seed's field password. */
export const SUBSCRIPTION_FIXTURE_PASSWORD = 'demo password field';

const ZONE = DEFAULT_TENANT_TIMEZONE;
const rupiah = (n: number) => n * MINOR_UNITS_PER_MAJOR;

/** `YYYY-MM-DD` this many months and days from an office date, on the office's calendar. */
function shift(date: string, by: { months?: number; days?: number; years?: number }): string {
  return DateTime.fromISO(date, { zone: ZONE }).plus(by).toISODate() as string;
}

/** A subscription of a whole period ending on `endDate`: a year, or six months. */
function ending(
  endDate: string,
  period: { years?: number; months?: number },
  rest: Pick<KpmSubscription, 'pricePerLeaderMinor' | 'maxLeaders' | 'keepActiveAfterEnd'>,
): KpmSubscription {
  return {
    startDate: shift(shift(endDate, { years: -(period.years ?? 0), months: -(period.months ?? 0) }), { days: 1 }),
    endDate,
    currency: 'IDR',
    ...rest,
  };
}

/** Each office's subscription on a given today — pure, so the spec and the guide read the same plan. */
export function planSubscriptions(today: string): Record<'0417' | '0555' | '0601' | '0602', KpmSubscription> {
  return {
    '0417': ending(shift(today, { months: 3 }), { years: 1 }, {
      pricePerLeaderMinor: rupiah(350_000), maxLeaders: 10, keepActiveAfterEnd: false,
    }),
    '0555': ending(shift(today, { days: 5 }), { months: 6 }, {
      pricePerLeaderMinor: rupiah(400_000), maxLeaders: null, keepActiveAfterEnd: false,
    }),
    '0601': ending(shift(today, { days: -10 }), { months: 6 }, {
      pricePerLeaderMinor: rupiah(350_000), maxLeaders: 5, keepActiveAfterEnd: false,
    }),
    '0602': ending(shift(today, { days: -3 }), { years: 1 }, {
      pricePerLeaderMinor: rupiah(350_000), maxLeaders: 2, keepActiveAfterEnd: true,
    }),
  };
}

/**
 * The five people this fixture makes, each with **their own** agent code: a code the seed counts would
 * move every account made after them onto another number than a fresh seed has always given it.
 */
export const SUBSCRIPTION_FIXTURE_PEOPLE = {
  owner0601: { email: 'owner@kpm0601.test', fullName: 'Rudi Hartanto', pronoun: 'he', agentCode: 'PRU-86001' },
  agent0601: { email: 'agent@kpm0601.test', fullName: 'Fitri Handayani', pronoun: 'she', agentCode: 'PRU-86002' },
  owner0602: { email: 'owner@kpm0602.test', fullName: 'Yohanes Saputra', pronoun: 'he', agentCode: 'PRU-86003' },
  aab0602: { email: 'aab@kpm0602.test', fullName: 'Sinta Maharani', pronoun: 'she', agentCode: 'PRU-86004' },
  agent0602: { email: 'agent@kpm0602.test', fullName: 'Joko Prasetyo', pronoun: 'he', agentCode: 'PRU-86005' },
} as const;

/** The two offices this fixture makes, by derived id. */
export const SUBSCRIPTION_OFFICES = {
  '0601': { _id: seedObjectId('subscription-fixture', 'kpm', '0601'), branchName: 'Cikarang Branch' },
  '0602': { _id: seedObjectId('subscription-fixture', 'kpm', '0602'), branchName: 'Bekasi Barat Branch' },
} as const;

type Role = 'ab' | 'aab' | 'agent';
interface Placed { id: string; ancestorIds: string[]; depth: number }
interface OfficeRef { _id: unknown; code: string; companyId: string }

/** What the demo seed hands over: its own helpers, so a person and a placement are made one way. */
export interface SubscriptionFixtureDeps {
  clock: Clock;
  Kpms: mongoose.Model<never>;
  companyId: string;
  kpm0417: string;
  kpm0555: string;
  user: (
    email: string, fullName: string, opts?: { pronoun?: 'she' | 'he'; agentCode?: string },
  ) => Promise<{ _id: unknown }>;
  configure: (kpmId: string) => Promise<unknown>;
  publish: (kpmId: string, at: Date) => Promise<unknown>;
  place: (
    kpm: OfficeRef, userId: string, role: Role, leader: Placed | null, opts?: { joinedDaysAgo?: number },
  ) => Promise<Placed>;
  recount: (kpmId: string, membershipId: string) => Promise<unknown>;
  daysAgo: (days: number) => Date;
}

export interface SubscriptionFixture {
  /** The office's today the plan was made from. */
  today: string;
  plan: ReturnType<typeof planSubscriptions>;
  /** The lines the printed guide carries for this fixture. */
  guide: string;
}

/** Set an office's subscription **only when it has none** — never over a walk's edit. */
async function subscribe(Kpms: mongoose.Model<never>, kpmId: string, subscription: KpmSubscription) {
  // `subscription: null` matches a row written before the field existed, too.
  await Kpms.updateOne({ _id: kpmId, subscription: null } as never, { $set: { subscription } } as never).exec();
}

/** One of the two new offices, found by its derived id or made with it. */
async function officeOf(
  deps: SubscriptionFixtureDeps,
  code: '0601' | '0602',
  ownerUserId: string,
): Promise<OfficeRef> {
  const { _id, branchName } = SUBSCRIPTION_OFFICES[code];
  const Kpms = deps.Kpms as unknown as mongoose.Model<{ companyId: string; code: string }>;
  const existing = await Kpms.findOne({ _id }).exec();
  if (!existing) {
    await Kpms.create({
      _id, companyId: deps.companyId, code, branchName, ownerUserId, timezone: ZONE,
      counters: { nextMemberSeq: 1 }, status: 'active',
    } as never);
  }
  return { _id, code, companyId: deps.companyId };
}

/** One of the five, through the seed's own `user`, with their own code. */
function person(deps: SubscriptionFixtureDeps, key: keyof typeof SUBSCRIPTION_FIXTURE_PEOPLE) {
  const { email, fullName, pronoun, agentCode } = SUBSCRIPTION_FIXTURE_PEOPLE[key];
  return deps.user(email, fullName, { pronoun, agentCode });
}

export async function seedSubscriptionFixture(deps: SubscriptionFixtureDeps): Promise<SubscriptionFixture> {
  const today = deps.clock.localDateFor(ZONE);
  const plan = planSubscriptions(today);

  await subscribe(deps.Kpms, deps.kpm0417, plan['0417']);
  await subscribe(deps.Kpms, deps.kpm0555, plan['0555']);

  // ---- 0601 · Cikarang: ended ten days ago. Configured and published like any office, so lifting its
  // end in a walk lets its two people into screens that work. Everybody in both new offices joined more
  // than six months ago, past any activation's life, so neither office adds a hire to the activation demo.
  const owner0601 = await person(deps, 'owner0601');
  const kpm0601 = await officeOf(deps, '0601', String(owner0601._id));
  await deps.configure(String(kpm0601._id));
  await deps.publish(String(kpm0601._id), deps.daysAgo(410));
  const agent0601User = await person(deps, 'agent0601');
  const root0601 = await deps.place(kpm0601, String(owner0601._id), 'ab', null, { joinedDaysAgo: 400 });
  await deps.place(kpm0601, String(agent0601User._id), 'agent', root0601, { joinedDaysAgo: 300 });
  await deps.recount(String(kpm0601._id), root0601.id);
  await subscribe(deps.Kpms, String(kpm0601._id), plan['0601']);

  // ---- 0602 · Bekasi Barat: ended three days ago and kept active, at its limit of two leaders.
  const owner0602 = await person(deps, 'owner0602');
  const kpm0602 = await officeOf(deps, '0602', String(owner0602._id));
  await deps.configure(String(kpm0602._id));
  await deps.publish(String(kpm0602._id), deps.daysAgo(430));
  const aab0602User = await person(deps, 'aab0602');
  const agent0602User = await person(deps, 'agent0602');
  const root0602 = await deps.place(kpm0602, String(owner0602._id), 'ab', null, { joinedDaysAgo: 420 });
  const aab0602 = await deps.place(kpm0602, String(aab0602User._id), 'aab', root0602, { joinedDaysAgo: 380 });
  await deps.place(kpm0602, String(agent0602User._id), 'agent', aab0602, { joinedDaysAgo: 300 });
  await deps.recount(String(kpm0602._id), aab0602.id);
  await deps.recount(String(kpm0602._id), root0602.id);
  await subscribe(deps.Kpms, String(kpm0602._id), plan['0602']);

  const guide = `
  SUBSCRIPTIONS at /admin/tenants  (Super Admin; from src/seed/subscription-fixture.ts, dated from the
             office's today ${today}. A subscription is written only where an office has none, so one
             edited in a walk is kept: run with --reset to date them from today)
    KPM 0417 · BSD City          ends ${plan['0417'].endDate}, Rp 350,000 a leader, Leaders 6 / 10 — the Owner,
                                 the Admin, Agus, Sari, Dewi and Arief
    KPM 0555 · Kelapa Gading     ends ${plan['0555'].endDate}, five days on; no limit, so Leaders reads the count
    KPM 0601 · Cikarang          Ended ${plan['0601'].endDate}, not kept active:
      owner@kpm0601.test         Rudi, the Owner — the page, "contact AgencyBoost", at any address
      agent@kpm0601.test         Fitri, an Agent — the same page
    KPM 0602 · Bekasi Barat      Ended — kept active ${plan['0602'].endDate}; Leaders 2 / 2:
      owner@kpm0602.test         Yohanes, the Owner: everything works. At /people/members, Joko → AAB
                                 is refused, naming the limit of 2
      aab@kpm0602.test           Sinta, an AAB leading Joko
      agent@kpm0602.test         Joko, an Agent — the one to try to promote
`;

  return { today, plan, guide };
}
