import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { PRODUCTION } from '@/domain/constants';
import { KpmSetup, type SetupFacts } from './kpm-setup.service';

const ctx = RequestContext.tenantRead('66f0000000000000000000a1', 'kpm-setup-spec');
const FACTS: SetupFacts = { today: '2026-09-14', month: '2026-09', timezone: 'Asia/Jakarta', headcount: 1, target: null, held: [] };

/** The card's reads over fakes: the office's row as given, its month rows as given, and nothing else held. */
function setup(office: Record<string, unknown> | null, months: Record<string, unknown>[]) {
  const kpms = { findById: () => ({ select: () => ({ lean: () => ({ exec: async () => office }) }) }) };
  const productionMonths = { find: jest.fn(async () => months) };
  return new KpmSetup(
    { marksOf: async () => new Map(), setOnce: jest.fn() } as never,
    kpms as never,
    { count: async () => 0 } as never,
    { exists: async () => false } as never,
    productionMonths as never,
    { count: async () => 0 } as never,
    { findOne: async () => null } as never,
    {} as never,
    new FixedClock(new Date('2026-09-14T03:00:00Z')),
  );
}

/**
 * **The setup card over an office row that says little** (P19.3-T2 AC-7; ADR-0214 §11): no creation stamp, no grace
 * of its own, a month row written before its revision was counted. The months still open are judged as the data upload
 * judges them, on the platform's grace.
 */
describe('KpmSetup.read over an office row that says little (P19.3-T2 AC-7)', () => {
  it('P19.3-T2 AC-7 an office with no creation stamp counts from January, on the platform’s grace days', async () => {
    const reading = await setup(null, []).read(ctx, FACTS);
    expect(reading.from).toBe('2026-01');
    // Every month never written stays open `LOCK_GRACE_DAYS` from today; September on its own schedule.
    const closes = `2026-09-${String(14 + PRODUCTION.LOCK_GRACE_DAYS).padStart(2, '0')}`;
    expect(reading.missing.slice(0, 8).map((m) => m.month)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08'].map((m) => `2026-${m}`));
    expect(reading.missing.slice(0, 8).every((m) => m.closesOn === closes)).toBe(true);
    expect(reading.missing[8]).toEqual({ month: '2026-09', closesOn: `2026-10-${String(PRODUCTION.LOCK_GRACE_DAYS).padStart(2, '0')}` });
    expect(reading.setup).toMatchObject({ done: 0, branchFilled: false, openMonth: { month: '2026-01', closesOn: closes } });
  });

  it('ADR-0214 §11 a month row with no revision stored is a month never written: open past its schedule', async () => {
    const reading = await setup({ createdAt: new Date('2026-08-02T03:00:00Z'), settings: {} }, [
      { month: '2026-08', lockOverride: null, firstWrittenOn: null },
    ]).read(ctx, FACTS);
    expect(reading.from).toBe('2026-08');
    expect(reading.missing[0]).toEqual({ month: '2026-08', closesOn: '2026-09-21' });
  });
});
