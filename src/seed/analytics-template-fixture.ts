import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { up as advancedAnalyticsV1, type AdvancedAnalyticsV1Result } from '@/migrations/0057-advanced-analytics-v1';

/**
 * **Every seeded template's *Advanced analytics* section** (P19.5-T1; ADR-0214 §9), written by the migration every
 * environment runs, so the demo holds what production holds after the deploy:
 *
 * | What | Its state | Who to sign in as, and what they see |
 * |---|---|---|
 * | **Prudential template** | version 1 published — today's seven upload columns, the four system ones marked *Sistem* — and **Prudential's §3 seed as a draft v2**: `^[0-9]{8}$`, which the seeded five-digit codes do not match | `superadmin@agencyboost.test` at `/admin/companies/{Prudential}/templates/{its id}`: the eighth row *Advanced analytics*, *"6 dari 6 bagian aktif · 7 kolom data upload"*, *Draf*; its *Data upload* tab says *"<n> dari <n> kode terdaftar tidak cocok (mis. …)"*, and *Terbitkan* opens *Belum bisa diterbitkan* |
 * | every other template | version 1 published, its pattern the first every registered code of its KPMs matches | the same row, *Terbit v1* |
 * | KPM 0417 | reads the Prudential template's version 1 live | `owner@kpm0417.test` at `/kpm/data-upload`: *"Kolom mengikuti Prudential template v1."* |
 *
 * Idempotent, as the migration is: a re-seed writes nothing, and a version published in a walk is kept.
 */
export async function seedAnalyticsTemplateFixture(deps: { clock: Clock }): Promise<AdvancedAnalyticsV1Result & { guide: string }> {
  const result = await advancedAnalyticsV1(mongoose.connection.db!, deps.clock.now());
  const guide = `
    Every template               "Advanced analytics", the eighth section: version 1 published — the seven
                                 upload columns of today. Prudential template also holds a draft v2 with
                                 the 8-digit agent code format, which the seeded codes do not match, so its
                                 Terbitkan opens "Belum bisa diterbitkan" (from src/seed/analytics-template-fixture.ts)
`;
  return { ...result, guide };
}
