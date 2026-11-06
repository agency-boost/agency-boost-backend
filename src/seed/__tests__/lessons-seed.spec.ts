import { join } from 'node:path';
import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { SEED_TRAINING_MODULES } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { writeLessonFolder, type LessonFolder } from '../../../test/lesson-folder';
import { StubStorage } from '../../../test/stub-storage';
import { seedDemo, type SeedResult } from '../demo';
import {
  DEMO_LESSON_MAP, lessonsFolderFrom, seedLessonsFixture, SUPERPROJECT_LESSONS_DIR,
} from '../lessons-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

type Row = { version: number; payload: { modules: { code: string; content?: { files?: { mimeType: string; label: string }[] } }[] } };

/** A company's default template's newest published training. */
async function newestOf(slug: string, kind?: string): Promise<Row> {
  const company = await col('companies').findOne(kind ? { kind, deletedAt: null } : { slug });
  const template = await col('templates').findOne({ companyId: String(company!._id), isDefault: true, deletedAt: null });
  return (await col('companyTemplates').find({
    companyId: String(company!._id), templateId: String(template!._id), kind: 'training_taxonomy', status: 'published',
  }).sort({ version: -1 }).limit(1).toArray())[0] as unknown as Row;
}

/**
 * **P19.6-T3 AC-2 — "The demo seed does the same"** (`lessons-fixture.ts`): the operator's import, run by the seed on
 * Prudential and on the Template company, from a lesson folder shaped as the delivered one, through storage's stub.
 */
describe('P19.6-T3 the lessons, seeded', () => {
  const clock = new FixedClock(new Date('2026-11-06T03:00:00Z'));
  const storage = new StubStorage();
  let folder: LessonFolder;
  let seeded: SeedResult;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    folder = writeLessonFolder();
    seeded = await seedDemo({ clock, log: quiet, storage, lessons: folder.dir });
  }, RUN_MS);
  afterAll(async () => {
    folder.remove();
    await stopMongo();
  });

  it('P19.6-T3 AC-2 maps every one of the platform defaults’ Sales modules to a Sales lesson, by code', () => {
    expect(Object.keys(DEMO_LESSON_MAP).sort()).toEqual(SEED_TRAINING_MODULES.map((m) => m.code).sort());
    expect(new Set(Object.values(DEMO_LESSON_MAP))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('P19.6-T3 AC-1 AC-2 Prudential’s template carries a lesson first in each Sales module, its PDF beside it, the demonstration material after', async () => {
    expect(seeded.lessons).toMatchObject({ state: 'stored' });
    const prudential = seeded.lessons.companies.find((c) => c.slug === 'prudential')!.report;
    expect(prudential.templates[0]).toMatchObject({ outcome: 'published' });
    const row = await newestOf('prudential');
    for (const [code, n] of Object.entries(DEMO_LESSON_MAP)) {
      const files = row.payload.modules.find((m) => m.code === code)!.content!.files!;
      expect([code, files.slice(0, 2).map((f) => f.mimeType)]).toEqual([code, ['text/html', 'application/pdf']]);
      expect(files[0].label).toBe(folderTitle(n));
      // The template's demonstration PDF (P19.4-T1's seed) stays, after the lesson.
      expect(files.slice(2).some((f) => f.mimeType === 'application/pdf')).toBe(true);
    }
  });

  it('P19.6-T3 AC-1 the Template company’s Default template carries them too, as the company’s own copies', async () => {
    const library = seeded.lessons.companies.find((c) => c.slug !== 'prudential');
    expect(library?.report.attached).toBeGreaterThan(0);
    const row = await newestOf('', 'template');
    const files = row.payload.modules.find((m) => m.code === 'PROSPECT_LIST')!.content!.files!;
    expect(files[0].mimeType).toBe('text/html');
    const company = await col('companies').findOne({ kind: 'template', deletedAt: null });
    expect(storage.puts.filter((key) => key.startsWith(`dev/company/${String(company!._id)}/training/lessons/`)).length).toBeGreaterThan(0);
  });

  it('P19.6-T3 AC-4 no KPM is written: 0417’s modules hold what they held', async () => {
    const kpm = await col('kpms').findOne({ code: '0417' });
    const modules = await col('trainingModules').find({ kpmId: String(kpm!._id) }).toArray();
    const lessonFiles = modules.flatMap((m) => [...(m.companyContent?.files ?? []), ...(m.officeContent?.files ?? [])])
      .filter((f: { storageKey: string }) => f.storageKey.includes('/training/lessons/'));
    expect(lessonFiles).toEqual([]);
  });

  it('P19.6-T3 AC-2 a second run attaches nothing, publishes nothing and sends nothing', async () => {
    const again = await seedDemo({ clock, log: quiet, storage, lessons: folder.dir });
    expect(again.lessons).toMatchObject({ state: 'stored', attached: 0, published: 0, sent: 0 });
    expect(again.written.companyTemplates ?? 0).toBe(0);
  }, RUN_MS);
});

/** Lesson n's title, as the index gives it. */
function folderTitle(n: number): string {
  return [
    'Leads generation: 8 cara mendapat calon nasabah',
    'Media sosial & leads tracker: dari konten ke janji temu',
    'Fact finding: menghitung kebutuhan perlindungan nasabah',
    'Handling objections: menjawab keberatan lalu closing',
    'Cross-sell: menambah perlindungan dan mempertahankan nasabah',
  ][n - 1];
}

describe('P19.6-T3 the lessons’ folder for the seed', () => {
  it('P19.6-T3 AC-2 SEED_LESSONS_DIR names it; else the superproject’s beside this repository, where it exists', () => {
    expect(lessonsFolderFrom({ SEED_LESSONS_DIR: ' /tmp/lessons ' })).toBe('/tmp/lessons');
    expect(SUPERPROJECT_LESSONS_DIR).toBe(join(__dirname, '../../../../revisions/2026-11-03/files/training-modules'));
    const found = lessonsFolderFrom({});
    expect(found === null || found === SUPERPROJECT_LESSONS_DIR).toBe(true);
  });

  it('P19.6-T3 AC-2 without a folder, without storage, or with a folder that is no lesson set, the seed skips the lessons and says why', async () => {
    const clock = new FixedClock(new Date('2026-11-06T03:00:00Z'));
    const base = { clock, storage: new StubStorage(), prudential: '66f0000000000000000000c1' };
    expect(await seedLessonsFixture({ ...base, folder: null })).toMatchObject({ state: expect.stringContaining('no lessons folder'), attached: 0 });
    expect(await seedLessonsFixture({ ...base, storage: null, folder: '/x' })).toMatchObject({ state: 'skipped: storage is not configured' });
    const skipped = await seedLessonsFixture({ ...base, folder: '/no/such/folder' });
    expect(skipped.state).toMatch(/^skipped: .*holds no index\.html/);
    expect(skipped.guide).toContain('skipped');
  });
});
