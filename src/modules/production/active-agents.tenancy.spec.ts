import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { activeAgentsIn, activeAgentsOver } from './active-agents';

const NOW = new Date('2026-11-20T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const RINA = '66f000000000000000000101';
const BUDI = '66f000000000000000000102';
const DEWI = '66f000000000000000000103';
const SITI = '66f000000000000000000104';
const YOGA = '66f000000000000000000105';
const M = 1_000_000_00; // Rp 1.000.000 in sen.

const owner = (kpmId = KPM_A) => new RequestContext('u-owner', 'none', {
  membershipId: '66f000000000000000000100', kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 5,
} as never);

const cell = (value: number | null, provenance: 'imported' | 'corrected' = 'imported') => ({ value, provenance });
const month = (kpmId: string, membershipId: string, m: string, ape: number | null, policies: number | null) => ({
  kpmId, membershipId, month: m, agentCode: membershipId.slice(-4), deletedAt: null,
  values: {
    ...(ape === null ? {} : { APE: cell(ape) }),
    ...(policies === null ? {} : { POLICY_COUNT: cell(policies) }),
  },
  ytdValues: {},
});

/**
 * **Active Agent, and who is behind the number** (P19.17-T1 AC-2; ADR-0267 §2): of the people asked about, those whose
 * month in the office's uploaded production shows APE > 0 or a policy (`MONTHLY_ACTIVE_AGENT`), each with the month's APE
 * and policies — `null`, *Belum diunggah*, when the office holds no file for the month, never 0.
 */
describe('Active Agent and the people behind it (P19.17-T1 AC-2)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    await mongoose.connection.db!.collection('monthlyAgentData').insertMany([
      month(KPM_A, RINA, '2026-11', 2_135_400_00, 1),
      // APE alone is enough, and so is a policy alone.
      month(KPM_A, BUDI, '2026-11', 5 * M, 0),
      month(KPM_A, DEWI, '2026-11', 0, 2),
      // Two zeroes: not active.
      month(KPM_A, SITI, '2026-11', 0, 0),
      // October is held for Rina only.
      month(KPM_A, RINA, '2026-10', 3 * M, 1),
      // Another office's November against Yoga's id: never his here.
      month(KPM_B, YOGA, '2026-11', 9 * M, 4),
    ] as never);
  });

  it('P19.17-T1 AC-2 counts APE > 0 or a policy, and lists each person with the month’s two figures, largest APE first', async () => {
    const read = await activeAgentsIn(wired.productionReadings, owner(), [RINA, BUDI, DEWI, SITI, YOGA], '2026-11');
    expect(read).toEqual({
      month: '2026-11', held: true, count: 3,
      people: [
        { membershipId: BUDI, apeMinor: 5 * M, policies: 0 },
        { membershipId: RINA, apeMinor: 2_135_400_00, policies: 1 },
        { membershipId: DEWI, apeMinor: 0, policies: 2 },
      ],
    });
  });

  it('P19.17-T1 AC-2 counts only the people asked about: a unit’s, not the office’s', async () => {
    expect(await activeAgentsIn(wired.productionReadings, owner(), [DEWI, SITI], '2026-11'))
      .toMatchObject({ count: 1, people: [{ membershipId: DEWI }] });
  });

  it('P19.17-T1 AC-2 reads a month the office holds no file for as not uploaded: null, nobody listed', async () => {
    expect(await activeAgentsIn(wired.productionReadings, owner(), [RINA, BUDI], '2026-09'))
      .toEqual({ month: '2026-09', held: false, count: null, people: [] });
    // A month held for somebody else is held: a person without a row there is not active.
    expect(await activeAgentsIn(wired.productionReadings, owner(), [BUDI], '2026-10'))
      .toEqual({ month: '2026-10', held: true, count: 0, people: [] });
  });

  it('P19.17-T1 AC-2 somebody active by a policy alone, with no APE held, is listed after every APE, by policies', () => {
    // The scorecard's cells (ADR-0267 §2): Agus with APE, Bayu and Citra with policies and no APE cell at all.
    type Cell = { apeMonthly: number | null; policyCountMonthly: number | null };
    const cells = new Map<string, Map<string, Cell>>([
      ['agus', new Map([['2026-11', { apeMonthly: 1 * M, policyCountMonthly: null }]])],
      ['bayu', new Map([['2026-11', { apeMonthly: null, policyCountMonthly: 1 }]])],
      ['citra', new Map([['2026-11', { apeMonthly: null, policyCountMonthly: 3 }]])],
    ]);
    expect(activeAgentsOver(cells, ['bayu', 'agus', 'citra'], '2026-11', true)).toEqual({
      month: '2026-11', held: true, count: 3,
      people: [
        { membershipId: 'agus', apeMinor: 1 * M, policies: null },
        { membershipId: 'citra', apeMinor: null, policies: 3 },
        { membershipId: 'bayu', apeMinor: null, policies: 1 },
      ],
    });
  });

  it('P19.17-T1 AC-2 never reads another office’s production (cross-tenant)', async () => {
    expect(await activeAgentsIn(wired.productionReadings, owner(), [YOGA], '2026-11')).toMatchObject({ count: 0, people: [] });
    expect(await activeAgentsIn(wired.productionReadings, owner(KPM_B), [RINA, YOGA], '2026-11')).toEqual({
      month: '2026-11', held: true, count: 1, people: [{ membershipId: YOGA, apeMinor: 9 * M, policies: 4 }],
    });
  });
});
