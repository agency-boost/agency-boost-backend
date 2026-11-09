import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { byKode } from '@/modules/production/upload-columns';
import { configModule } from './config-module';
import { buildCoachingOffice, COMPANY, KPM_A, KPM_B, type CoachingOffice, type Who } from './coaching-office';
import { seedUnitLeads } from './unit-office';

/**
 * **The Owner's reporting office** (Phase 18): `test/coaching-office.ts`'s people, goals, production, sessions and
 * logging, and `test/unit-office.ts`'s leads — plus what the reporting reads that they do not hold:
 *
 * | What | Where |
 * |---|---|
 * | The company's name, and its carrier rules (the club tiers, MOC with the persistency criterion) | `companies`, `qualificationRules` |
 * | A recruitment lead at a late stage of 0417's ladder (Rina's, *AAJI licensed*), and one closed won in August (Indah's) | `leads` |
 * | Persistency and policy counts on the months held, so `MONTHLY_ACTIVE_AGENT` has figures | `monthlyAgentData` |
 * | *Since P19.5-T2:* Agus's months by kode, January's 210 M making his summed year to date 240 M (Aug) and 270 M (Sep) | `monthlyAgentData` |
 * | *Since P19.3-T1:* a unit persistency on Agus's row (79 Aug, 82 Sep — his own is 91) and Sari's (70 Aug, none Sep), what MOC reads (D6) | `monthlyAgentData` |
 * | Sign-ins: most of 0417 within the week, Dimas within the month, Tari and Lukas never; 0555's both 40 days ago | `users.lastLoginAt` |
 *
 * 0417's Owner is the root AB, with three ABs below them (the Admin, Agus, Hendra); Agus's agency holds Sari's and
 * Nina's units — Nina's nested in Sari's — so an agency, its *(Direct)* row and two AAB units all have members.
 */
export const REPORTING_NOW = new Date('2026-09-14T03:00:00Z');
const M = 1_000_000 * 100;

export interface ReportingOffice extends CoachingOffice {
  /** The Owner of 0555 for a read: its root AB, made its Owner. */
  ownerOfB(): RequestContext;
  userIdOf(who: Who): Promise<string>;
}

export async function buildReportingOffice(wired: ReturnType<typeof configModule>): Promise<ReportingOffice> {
  const office = await buildCoachingOffice(wired);
  await seedUnitLeads(office);
  const db = mongoose.connection.db!;
  await db.collection('companies').insertOne({
    _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential-reporting', deletedAt: null,
  });
  await wired.campaigns.seedForCompany(COMPANY);
  await wired.provisioning.seedLeadPipelines(KPM_B);

  const day = (d: string) => new Date(`${d}T03:00:00Z`);
  await db.collection('leads').insertMany([
    {
      kpmId: KPM_A, ownerMembershipId: office.id.RINA, type: 'recruitment', name: 'Late stage', statusCode: 'AAJI_LICENSED',
      outcome: null, outcomeAt: null, commitments: [], version: 1, deletedAt: null, dateRegistered: day('2026-08-03'),
      transitions: [{ fromStatusCode: null, toStatusCode: 'AAJI_LICENSED', at: day('2026-08-20'), byMembershipId: office.id.RINA }],
      contact: { phone: null, email: null },
    },
    {
      kpmId: KPM_A, ownerMembershipId: office.id.INDAH, type: 'recruitment', name: 'Closed won in August',
      statusCode: 'NEW_ACTIVE_AGENT', outcome: 'won', outcomeAt: day('2026-08-25'), commitments: [], version: 1, deletedAt: null,
      dateRegistered: day('2026-07-01'), contact: { phone: null, email: null },
      transitions: [{ fromStatusCode: null, toStatusCode: 'NEW_ACTIVE_AGENT', at: day('2026-08-24'), byMembershipId: office.id.INDAH }],
    },
  ]);

  // Persistency and a policy count on every row the coaching office holds (Indah, Dimas, Rina, Sari: January, August and
  // September — January the month that makes their summed year to date the file's, P19.5-T2).
  for (const who of ['INDAH', 'DIMAS', 'RINA', 'SARI'] as const) {
    await db.collection('monthlyAgentData').updateMany(
      { membershipId: office.id[who] },
      {
        $set: {
          'values.PERSISTENCY': { value: who === 'SARI' ? 72 : 88, provenance: 'imported', sourceBatchId: null },
          'values.POLICY_COUNT': { value: 2, provenance: 'imported', sourceBatchId: null },
        },
      },
    );
  }
  // Agus's own row, with his unit's persistency as the insurer reports it (D6, P19.3-T1) beside his own. His year to
  // date is the sum of his months held (R4, P19.5-T2): January's 210 M with August's and September's 30 M each makes the
  // 240 M and 270 M the file's year to date said.
  const imported = (value: number) => ({ value, provenance: 'imported', sourceBatchId: null });
  await db.collection('monthlyAgentData').insertMany([
    { kpmId: KPM_A, membershipId: office.id.AGUS, month: '2026-01', agentCode: 'AGUS', deletedAt: null, ...byKode({ apeMonthly: imported(210 * M) }) },
    ...['2026-08', '2026-09'].map((month) => ({
      kpmId: KPM_A, membershipId: office.id.AGUS, month, agentCode: 'AGUS', deletedAt: null,
      ...byKode({
        apeMonthly: imported(30 * M),
        persistencyMonthly: imported(91),
        unitPersistencyMonthly: imported(month === '2026-08' ? 79 : 82),
        policyCountMonthly: imported(1),
      }),
    })),
  ]);
  // Sari's unit persistency for August only: September, the latest month held, carries none — *Belum diunggah*.
  await db.collection('monthlyAgentData').updateOne(
    { membershipId: office.id.SARI, month: '2026-08' },
    { $set: { 'values.UNIT_PERSISTENCY': imported(70) } },
  );

  const userIdOf = async (who: Who) =>
    (await db.collection('memberships').findOne({ _id: new mongoose.Types.ObjectId(office.id[who]) }))!.userId as string;
  const signedIn = async (who: Who, at: Date | null) => {
    await db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(await userIdOf(who)) }, { $set: { lastLoginAt: at } });
  };
  for (const who of ['OWNER', 'ADMIN', 'AGUS', 'INDAH', 'SARI', 'RINA', 'BUDI', 'NINA', 'DODI', 'DEWI', 'PEER_AB', 'PEER_AAB', 'PEER_AGENT'] as const) {
    await signedIn(who, day('2026-09-12'));
  }
  await signedIn('DIMAS', day('2026-08-25'));
  for (const who of ['B_AB', 'B_AGENT'] as const) await signedIn(who, day('2026-08-05'));

  return {
    ...office,
    userIdOf,
    ownerOfB: () => {
      const b = office.as('B_AB');
      return new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true });
    },
  };
}

export { KPM_A, KPM_B, COMPANY };
