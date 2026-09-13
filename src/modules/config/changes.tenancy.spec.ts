import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-13T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });
}

/**
 * P4-T19. The batch is only worth having for two guarantees, and both live in the
 * validate pass: a refusal changes nothing, and a row somebody else moved refuses the
 * whole request instead of being silently overwritten.
 */
describe('staged configuration changes (P4-T19)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const companies = wired.companies as mongoose.Model<never>;
    const kpms = wired.kpms as mongoose.Model<never>;
    await companies.create({ _id: COMPANY, name: 'Prudential', slug: 'p' } as never);
    const sa = RequestContext.platform('root');
    for (const [i, code] of ['AGENT', 'AAB', 'AB'].entries()) {
      await wired.orgLevels.create(sa, { companyId: COMPANY, code, label: code, displayOrder: i + 1 });
    }
    await kpms.create({
      _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
    } as never);
    const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
    await wired.provisioning.seedRatioDefinitions(KPM_A, COMPANY, seeded.typeCodes);
  });

  const typeNamed = async (code: string) =>
    (await wired.activity.list(ctx(KPM_A), true)).flatMap((c) => c.types).find((t) => t.code === code)!;

  it('applies a batch in order', async () => {
    const submission = await typeNamed('SELL_SUBMISSION');

    await wired.changes.apply(ctx(KPM_A), [
      { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
      { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 'Closing' } },
    ]);

    const after = await wired.activity.list(ctx(KPM_A), true);
    expect(after.some((c) => c.code === 'REFERRALS')).toBe(true);
    expect((await typeNamed('SELL_SUBMISSION')).label).toBe('Closing');
  });

  it('lets a create name something an earlier op in the same batch made', async () => {
    /*
     * The reason validation runs against a projection rather than the database. Without
     * it the screen would have to send two requests and reason about the first's result,
     * which is the batching this endpoint exists to remove.
     */
    await wired.changes.apply(ctx(KPM_A), [
      { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
      { op: 'type.create', body: { code: 'REF_INTRO', categoryCode: 'REFERRALS', label: 'Intro' } },
    ]);

    const referrals = (await wired.activity.list(ctx(KPM_A))).find((c) => c.code === 'REFERRALS')!;
    expect(referrals.types.map((t) => t.code)).toEqual(['REF_INTRO']);
  });

  describe('a refusal leaves the office exactly as it was', () => {
    it('writes nothing when a later op is invalid', async () => {
      const submission = await typeNamed('SELL_SUBMISSION');

      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 'Closing' } },
        { op: 'category.create', body: { code: 'SELLING', label: 'Duplicate' } },
      ])).rejects.toMatchObject({ message: expect.stringContaining('already in use') });

      // The first op did not land.
      expect((await typeNamed('SELL_SUBMISSION')).label).toBe('Submission polis');
      expect((await wired.activity.list(ctx(KPM_A), true)).filter((c) => c.code === 'SELLING'))
        .toHaveLength(1);
    });

    it('refuses a type whose section does not exist, naming the code', async () => {
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'type.create', body: { code: 'X_ONE', categoryCode: 'NOWHERE', label: 'x' } },
      ])).rejects.toMatchObject({ message: expect.stringContaining('NOWHERE') });
    });

    it('refuses a rung the company does not have', async () => {
      const [first] = await wired.activity.list(ctx(KPM_A));
      await expect(wired.changes.apply(ctx(KPM_A), [
        {
          op: 'category.update', id: first.id, expectedVersion: first.version,
          body: { appliesToOrgLevelCodes: ['DIRECTOR'] },
        },
      ])).rejects.toMatchObject({ code: 'CONFIG_RUNG_UNKNOWN' });
    });

    it('refuses a formula change on a platform ratio before writing anything', async () => {
      const ratio = (await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE')!;
      await expect(wired.changes.apply(ctx(KPM_A), [
        {
          op: 'ratio.update', id: ratio.id, expectedVersion: ratio.version,
          body: { benchmark: 0.9, numerator: ['SELL_PRESENTATION'] },
        },
      ])).rejects.toMatchObject({ code: 'CONFIG_RATIO_FORMULA_FIXED' });

      // Including the benchmark that shared the op.
      expect((await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE')!.benchmark)
        .toBe(ratio.benchmark);
    });

    it('names which change failed, not just what went wrong', async () => {
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'type.create', body: { code: 'X_ONE', categoryCode: 'NOWHERE', label: 'x' } },
      ])).rejects.toMatchObject({ message: expect.stringContaining('Change 2 (type.create)') });
    });
  });

  describe('two admins editing at once', () => {
    it('refuses the whole batch when a row moved on, naming the version', async () => {
      const submission = await typeNamed('SELL_SUBMISSION');
      // Somebody else saves first.
      await wired.activity.updateType(ctx(KPM_A), submission.id, { label: 'Theirs' });

      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 'Mine' } },
      ])).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        message: expect.stringContaining('changed while you were editing'),
      });

      expect((await typeNamed('SELL_SUBMISSION')).label).toBe('Theirs');
    });

    it('requires a version on anything that changes an existing row', async () => {
      const submission = await typeNamed('SELL_SUBMISSION');
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: submission.id, body: { label: 'Mine' } },
      ])).rejects.toMatchObject({ message: expect.stringContaining('which version it was read at') });
    });

    it('lets two ops touch one row, because the projection moves on', async () => {
      const submission = await typeNamed('SELL_SUBMISSION');
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 'Closing' } },
        { op: 'type.archive', id: submission.id, expectedVersion: submission.version + 1 },
      ]);

      const after = await typeNamed('SELL_SUBMISSION');
      expect(after).toMatchObject({ label: 'Closing', status: 'archived' });
    });
  });

  it('does not publish — the working copy moves and agents do not', async () => {
    const submission = await typeNamed('SELL_SUBMISSION');
    await wired.config.publish(ctx(KPM_A));

    await wired.changes.apply(ctx(KPM_A), [
      { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 'Closing' } },
    ]);

    const published = await wired.config.readPublished(ctx(KPM_A));
    const stillOld = published.activity.flatMap((c) => c.types).find((t) => t.code === 'SELL_SUBMISSION');
    expect(stillOld?.label).toBe('Submission polis');
    expect((await wired.config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(true);
  });
});
