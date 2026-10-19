import mongoose from 'mongoose';
import { Kpm, KpmSchema } from './kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

/**
 * Branch info at the model level (P4-T5).
 *
 * The service is exercised whole in `tenant.service.tenancy.spec.ts`; this pins the two
 * things the *schema* has to guarantee, because a default that arrives wrong is invisible
 * until a period computation two phases later reads it.
 */
describe('the office fiscal year (P4-T5)', () => {
  let kpms: mongoose.Model<never>;

  beforeAll(async () => {
    await startMongo();
    kpms = mongoose.model(Kpm.name, KpmSchema) as never;
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  const office = (over: Record<string, unknown> = {}) => ({
    companyId: 'c1', code: '0417', branchName: 'BSD', timezone: 'Asia/Jakarta',
    locale: 'id-ID', currency: 'IDR', status: 'active', ...over,
  });

  it('starts in January, which is what every office in v1 uses', async () => {
    const created = await kpms.create(office() as never);
    expect((created as unknown as { fiscalYearStartMonth: number }).fiscalYearStartMonth).toBe(1);
  });

  it('refuses a month that is not a month', async () => {
    // A 0 or a 13 would read as a valid month index somewhere downstream and quietly
    // shift every period by one.
    await expect(kpms.create(office({ fiscalYearStartMonth: 13 }) as never)).rejects.toThrow();
    await expect(kpms.create(office({ fiscalYearStartMonth: 0 }) as never)).rejects.toThrow();
  });

  it('keeps the timezone column even though v1 has one value (ADR-0016)', async () => {
    // Removing it because there is only one value would reintroduce parity defect F-01:
    // the thing the rule guards against is the *server's* clock.
    const created = await kpms.create(office() as never);
    expect((created as unknown as { timezone: string }).timezone).toBe('Asia/Jakarta');
  });
});
