import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { PLATFORM_DEFAULT_EFFECTIVE_FROM } from '@/modules/config/analytics-config';
import { MIGRATIONS } from '@/migrations/migrations';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo } from '../demo';

/**
 * **The Data upload on a fresh deploy, then the seed** (P19.21-T1, `data-upload-fixture.ts`; found 2026-11-20).
 *
 * A walk on a fresh database found every seeded month from January 2025 to October 2026 red — *never uploaded* — while
 * the Overview summed their figures. Migration 0057 ran on the empty database, before any KPM existed, and started every
 * column of the template the month of the deploy; the seed then wrote its history by kode, which 0057's legacy read
 * missed; and `monthFill` read a month with no column in force as missing whatever it held. So this runs what a deploy
 * runs — the whole migration list on an empty database — then the seed, at the walk's own hour, and reads the page as
 * the Owner does.
 */
const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);
const year = (y: number) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

describe('the Data upload seed — a fresh deploy, then the seed, at 10:00 on 20 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let owner: RequestContext;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    // What `deploy.sh` runs before the seed: every migration, on a database holding nothing.
    for (const [, run] of MIGRATIONS) await run(mongoose.connection.db!, clock.now());
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    const account = await col('users').findOne({ email: 'owner@kpm0417.test' });
    const member = (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
    owner = new RequestContext(String(member.userId), 'none', {
      membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
      hierarchyRole: member.role, status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    } as never);
  }, RUN_MS);
  afterAll(stopMongo);

  it('starts every column of the template 0417 reads at January 2024, never the month the deploy ran', async () => {
    const published = await wired.analyticsConfig.publishedFor(owner);
    expect(published.templateName).toBe('Prudential template');
    expect(new Set(published.config.uploadFields.map((f) => f.effectiveFrom))).toEqual(new Set([PLATFORM_DEFAULT_EFFECTIVE_FROM]));
  });

  it('shows the months the guide promises: 2024 red, last year green but Mar and Jul, this year green but the month before last', async () => {
    const view = await wired.production.readMonth(owner, '2026-11');
    const red = (y: number) => view.months.filter((m) => m.month.startsWith(`${y}-`) && m.status === 'missing').map((m) => m.month);
    // The grid runs from January 2024 (ADR-0274 §3) to this month.
    expect(view.months[0].month).toBe('2024-01');
    expect(view.months.at(-1)!.month).toBe('2026-11');
    // `data-upload-fixture.ts`: 2024 every month red — required, and none was ever sent.
    expect(red(2024)).toEqual(year(2024));
    // Last year green but March and July, never uploaded.
    expect(red(2025)).toEqual(['2025-03', '2025-07']);
    // This year: the reporting fixture's files to three months ago, the month before last left empty, last month's
    // import and this month's standing file (`demo.ts`, MONTHLY UPLOAD).
    expect(red(2026)).toEqual(['2026-09']);
    // Each month the seed holds a figure in is uploaded — the defect's own sentence, asked directly.
    const held = new Set(await col('monthlyAgentData').distinct('month', { kpmId: owner.kpmId, deletedAt: null }) as string[]);
    for (const month of view.months.filter((m) => held.has(m.month))) expect([month.month, month.status]).not.toEqual([month.month, 'missing']);
  });

  it('marks a year to date Belum lengkap for the months this year that are not complete, September among them', async () => {
    const view = await wired.production.readMonth(owner, '2026-11');
    const ape = view.config.columns.find((c) => c.kode === 'APE')!;
    expect(ape.ytdMissingMonths).toContain('2026-09');
    const complete = new Set(view.months.filter((m) => m.status === 'complete').map((m) => m.month));
    expect(ape.ytdMissingMonths.filter((m) => complete.has(m))).toEqual([]);
    expect(ape.ytdMissingMonths.every((m) => m >= '2026-01' && m <= '2026-11')).toBe(true);
    // The page's banner reads the same months.
    expect(view.ytdMissingMonths).toEqual(expect.arrayContaining(['2026-09']));
  });
});
