import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { BrandingReader } from '@/modules/branding/branding-reader';
import { KpmBrandingRepository } from '@/modules/branding/kpm-branding.repository';
import { KpmBranding, KpmBrandingSchema } from '@/modules/branding/kpm-branding.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { StubStorage } from '../../../test/stub-storage';
import { BRANDED_DEMO, seedBrandingFixture } from '../branding-fixture';

const KPM_0555 = '66f0000000000000000005a5';
const KPM_0417 = '66f0000000000000000004a1';

/**
 * **One KPM branded, for a reviewer** (P19.6-T1; `branding-fixture.ts`): 0555 shows its own teal and deep blue, a logo
 * and a mascot when storage is configured, read back through the product's own reader; 0417 keeps AgencyBoost's; and a
 * second run writes nothing.
 */
describe('the branding seed (P19.6-T1)', () => {
  const clock = new FixedClock(new Date('2026-11-06T03:00:00Z'));
  let reader: BrandingReader;
  let storage: StubStorage;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    const kpms = mongoose.models[Kpm.name] ?? mongoose.model(Kpm.name, KpmSchema);
    await kpms.create({ _id: KPM_0555, companyId: '66f0000000000000000000c1', code: '0555', branchName: 'Kelapa Gading Branch', timezone: 'Asia/Jakarta' });
    await kpms.create({ _id: KPM_0417, companyId: '66f0000000000000000000c1', code: '0417', branchName: 'Cempaka Putih', timezone: 'Asia/Jakarta' });
    storage = new StubStorage();
    const named = mongoose.models[NamedTemplate.name] ?? mongoose.model(NamedTemplate.name, NamedTemplateSchema);
    const sections = mongoose.models[CompanyTemplate.name] ?? mongoose.model(CompanyTemplate.name, CompanyTemplateSchema);
    const rows = mongoose.models[KpmBranding.name] ?? mongoose.model(KpmBranding.name, KpmBrandingSchema);
    reader = new BrandingReader(
      new KpmBrandingRepository(rows as never), kpms as never, sections as never,
      new AnalyticsConfigReader(kpms as never, named as never, sections as never), storage,
    );
  }, 120_000);

  afterAll(async () => {
    await stopMongo();
  });

  it('P19.6-T1 seeds 0555 in its own colours, logo and mascot; 0417 keeps AgencyBoost’s; a second run writes nothing', async () => {
    const first = await seedBrandingFixture({ clock, storage, kpmId: KPM_0555 });
    expect(first).toEqual({ kpmId: KPM_0555, written: 1, images: 'stored' });
    const shown = (await reader.shownFor(KPM_0555))!;
    expect(shown.palette).toMatchObject({ primary: BRANDED_DEMO.primary, secondary: BRANDED_DEMO.secondary, primaryContrast: '#ffffff' });
    expect(shown.logo).toMatchObject({ key: `dev/${KPM_0555}/${BRANDED_DEMO.logoFolder}`, height: 96 });
    expect(shown.mascot).toEqual({ default: `dev/${KPM_0555}/${BRANDED_DEMO.mascotFolder}`, poses: {} });
    expect(storage.puts).toContain(`dev/${KPM_0555}/${BRANDED_DEMO.logoFolder}/icon-512.png`);
    expect((await reader.shownFor(KPM_0417))!.palette).toBeNull();

    const sent = storage.puts.length;
    expect(await seedBrandingFixture({ clock, storage, kpmId: KPM_0555 })).toMatchObject({ written: 0 });
    expect(storage.puts.length).toBe(sent);
  });

  it('P19.6-T1 without storage, seeds the colours alone', async () => {
    await clearCollections();
    const kpms = mongoose.models[Kpm.name]!;
    await kpms.create({ _id: KPM_0555, companyId: '66f0000000000000000000c1', code: '0555', branchName: 'Kelapa Gading Branch', timezone: 'Asia/Jakarta' });
    expect(await seedBrandingFixture({ clock, storage: null, kpmId: KPM_0555 }))
      .toEqual({ kpmId: KPM_0555, written: 1, images: 'skipped: storage is not configured' });
    const shown = (await reader.shownFor(KPM_0555))!;
    expect(shown.palette!.primary).toBe(BRANDED_DEMO.primary);
    expect(shown.logo).toBeNull();
  });
});
