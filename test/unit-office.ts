import mongoose from 'mongoose';
import { KPM_A, KPM_B, type CoachingOffice, type Who } from './coaching-office';

/**
 * **The Unit Dashboard's office** (Phase 15): `test/coaching-office.ts`'s people, sessions, goals and
 * production — a unit nested two deep under Agus (Sari → Nina → Dodi) included — plus the leads the
 * *Leads* column counts. The tenancy spec, the HTTP spec and the measurement read the same rows.
 *
 * | Who | Open sales (closing this month) | Open recruitment (nominated this month) |
 * |---|---|---|
 * | RINA | 3 (1) — and a won one promised this month, which counts nowhere | 2 (1) — and one on the terminal stage |
 * | INDAH | 1 (1) | 1 (1) |
 * | DODI | 0 | 1 (0) — promised last month |
 * | B_AGENT (office B) | 2 (2) | 0 |
 */
export const UNIT_MONTH = '2026-09';

/** The recruitment ladder's terminal stage, as `SEED_LEAD_STATUSES` provisions it. */
const TERMINAL = 'NEW_ACTIVE_AGENT';

export async function seedUnitLeads(office: CoachingOffice): Promise<void> {
  const db = mongoose.connection.db!;
  let n = 0;
  const lead = (who: Who, over: Record<string, unknown>, kpmId = KPM_A) => {
    n += 1;
    return {
      kpmId, ownerMembershipId: office.id[who], type: 'sales', name: `Lead ${n}`, statusCode: null, outcome: null,
      commitments: [], nextActionDate: null, version: 1, deletedAt: null, dateRegistered: new Date('2026-08-01T02:00:00Z'),
      contact: { phone: null, email: null }, transitions: [], ...over,
    };
  };
  const promised = (month = UNIT_MONTH) => [{ month, at: new Date('2026-09-02T02:00:00Z'), byMembershipId: 'x' }];
  await db.collection('leads').insertMany([
    lead('RINA', {}),
    lead('RINA', { statusCode: 'FOLLOW_UP' }),
    lead('RINA', { commitments: promised() }),
    lead('RINA', { outcome: 'won', commitments: promised() }),
    lead('RINA', { type: 'recruitment', statusCode: 'MEETING_SCHEDULED', commitments: promised() }),
    lead('RINA', { type: 'recruitment', statusCode: null }),
    lead('RINA', { type: 'recruitment', statusCode: TERMINAL }),
    lead('INDAH', { commitments: promised() }),
    lead('INDAH', { type: 'recruitment', commitments: promised() }),
    lead('DODI', { type: 'recruitment', commitments: promised('2026-08') }),
    // Deleted: no lead at all.
    lead('DODI', { type: 'recruitment', commitments: promised(), deletedAt: new Date('2026-09-03T02:00:00Z') }),
    lead('B_AGENT', { commitments: promised() }, KPM_B),
    lead('B_AGENT', { commitments: promised() }, KPM_B),
  ]);
}
