import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-13T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
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
    const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_A);
    await wired.provisioning.seedRatioDefinitions(KPM_A, seeded.typeCodes);
  });

  const typeNamed = async (code: string) =>
    (await wired.activity.list(ctx(KPM_A), true)).flatMap((c) => c.types).find((t) => t.code === code)!;

  /** A second office of the same company, provisioned the ordinary way. */
  async function provisionB(): Promise<void> {
    await (wired.kpms as mongoose.Model<never>).create({
      _id: KPM_B, companyId: COMPANY, code: '0418', branchName: 'B', timezone: 'Asia/Jakarta',
    } as never);
    const seeded = await wired.provisioning.seedActivityTaxonomy(KPM_B);
    await wired.provisioning.seedRatioDefinitions(KPM_B, seeded.typeCodes);
  }

  describe('another office’s row', () => {
    /*
     * The batch had **no cross-tenant test at all** — the only file in this module without
     * one, which is how the defect below survived: every sibling spec asserts 404 for a row
     * in another office, and this one asserted nothing.
     */
    it('is not found — 404, the way every single-operation route answers it', async () => {
      await provisionB();
      const theirs = (await wired.ratios.list(ctx(KPM_B)))[0];

      const err = await wired.changes.apply(ctx(KPM_A), [{
        op: 'ratio.update', id: theirs.id, expectedVersion: theirs.version, body: { benchmark: 0.9 },
      }]).then(
        () => { throw new Error('the batch accepted another office’s row'); },
        (e: { code: string; getStatus(): number }) => e,
      );

      /*
       * It answered `400` until 2026-09-17. The projection is built from `ctx`-scoped reads,
       * so another office's id lands in the not-found branch — and `fail` fixes the status
       * at 400, which told the caller their request was malformed rather than that the row
       * is not theirs.
       */
      expect(err.code).toBe('NOT_FOUND');
      expect(err.getStatus()).toBe(404);
    });

    it('is left exactly as it was', async () => {
      await provisionB();
      const theirs = (await wired.ratios.list(ctx(KPM_B)))[0];
      await wired.changes.apply(ctx(KPM_A), [{
        op: 'ratio.update', id: theirs.id, expectedVersion: theirs.version, body: { benchmark: 0.9 },
      }]).catch(() => undefined);

      expect((await wired.ratios.list(ctx(KPM_B)))[0]).toMatchObject({
        benchmark: theirs.benchmark, version: theirs.version,
      });
    });
  });

  describe('every operation reaches the service that owns it', () => {
    /*
     * Six of the twelve cases in the dispatch switch were never exercised through the batch.
     * A copy-paste mapping `category.restore` to `archiveCategory` would have passed the
     * whole suite, because each op's *rule* is tested on its own service and nothing tested
     * the wiring between them.
     */
    it('archives and restores a section', async () => {
      // *Recruitment*: a section holding a cascade type cannot be archived (ADR-0115 §2).
      const before = (await wired.activity.list(ctx(KPM_A), true)).find((c) => c.code === 'RECRUITMENT')!;
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'category.archive', id: before.id, expectedVersion: before.version },
      ]);
      expect((await wired.activity.list(ctx(KPM_A), true))
        .find((c) => c.id === before.id)!.status).toBe('archived');

      const archived = (await wired.activity.list(ctx(KPM_A), true)).find((c) => c.id === before.id)!;
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'category.restore', id: before.id, expectedVersion: archived.version },
      ]);
      expect((await wired.activity.list(ctx(KPM_A), true))
        .find((c) => c.id === before.id)!.status).toBe('active');
    });

    it('archives and restores an activity type', async () => {
      // Not a cascade type: those three cannot be archived (ADR-0115 §2).
      const type = await typeNamed('SELL_FOLLOWUP');
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'type.archive', id: type.id, expectedVersion: type.version },
      ]);
      expect((await typeNamed('SELL_FOLLOWUP')).status).toBe('archived');

      const archived = await typeNamed('SELL_FOLLOWUP');
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'type.restore', id: archived.id, expectedVersion: archived.version },
      ]);
      expect((await typeNamed('SELL_FOLLOWUP')).status).toBe('active');
    });

    it('refuses archiving a cascade type in a batch before any of it is written, naming the change (ADR-0115 §2)', async () => {
      const followUp = await typeNamed('SELL_FOLLOWUP');
      const type = await typeNamed('SELL_SUBMISSION');
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: followUp.id, expectedVersion: followUp.version, body: { label: 'Tindak lanjut' } },
        { op: 'type.archive', id: type.id, expectedVersion: type.version },
      ])).rejects.toMatchObject({
        code: 'ACTIVITY_TYPE_RESERVED', status: 409, details: { codes: ['SELL_SUBMISSION'] },
        message: expect.stringMatching(/^Change 2 \(type\.archive\): “Submission polis” cannot be archived/),
      });
      expect((await typeNamed('SELL_SUBMISSION')).status).toBe('active');
      // The edit before it was not written either.
      expect((await typeNamed('SELL_FOLLOWUP')).label).toBe(followUp.label);
    });

    it('archives a section once the batch has moved its cascade type out, and not before', async () => {
      const sections = await wired.activity.list(ctx(KPM_A), true);
      const leads = sections.find((c) => c.code === 'LEADS_GENERATION')!;
      const contacted = await typeNamed('LEADS_CONTACTED');

      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'category.archive', id: leads.id, expectedVersion: leads.version },
      ])).rejects.toMatchObject({ code: 'ACTIVITY_TYPE_RESERVED', details: { codes: ['LEADS_CONTACTED'] } });

      await wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: contacted.id, expectedVersion: contacted.version, body: { categoryCode: 'SELLING' } },
        { op: 'category.archive', id: leads.id, expectedVersion: leads.version },
      ]);
      expect((await wired.activity.list(ctx(KPM_A), true)).find((c) => c.code === 'LEADS_GENERATION')!.status)
        .toBe('archived');
      expect(await typeNamed('LEADS_CONTACTED')).toMatchObject({ categoryCode: 'SELLING', status: 'active' });
    });

    it('creates, archives and restores a ratio', async () => {
      await wired.changes.apply(ctx(KPM_A), [{
        op: 'ratio.create',
        body: {
          code: 'REFERRAL_RATE', label: 'Referral rate',
          numerator: ['SELL_SUBMISSION'], denominator: ['LEADS_CONTACTED'],
          benchmark: 0.2, comparison: 'gte',
        },
      }]);
      const made = (await wired.ratios.list(ctx(KPM_A), true)).find((r) => r.code === 'REFERRAL_RATE')!;
      expect(made.origin).toBe('office');

      await wired.changes.apply(ctx(KPM_A), [
        { op: 'ratio.archive', id: made.id, expectedVersion: made.version },
      ]);
      const gone = (await wired.ratios.list(ctx(KPM_A), true)).find((r) => r.code === 'REFERRAL_RATE')!;
      expect(gone.status).toBe('archived');

      await wired.changes.apply(ctx(KPM_A), [
        { op: 'ratio.restore', id: gone.id, expectedVersion: gone.version },
      ]);
      expect((await wired.ratios.list(ctx(KPM_A))).some((r) => r.code === 'REFERRAL_RATE')).toBe(true);
    });

    it('refuses an operation it has no case for, rather than doing nothing quietly', async () => {
      const ratio = (await wired.ratios.list(ctx(KPM_A)))[0];
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'ratio.frobnicate' as never, id: ratio.id, expectedVersion: ratio.version },
      ])).rejects.toThrow(/Unknown change/);
    });
  });

  describe('each body by its own rules, before anything is written (ADR-0030)', () => {
    /*
     * OD-51. An op's body never met the DTO its single-operation route applies, so through the
     * batch — the only path the screens use — a label of any length and a benchmark of any size
     * were written, a misspelt field was dropped in silence, and a label sent as a number failed
     * at `.trim()` *after* the ops ahead of it had landed.
     */
    const refusedWith = (ops: Parameters<typeof wired.changes.apply>[1]) =>
      wired.changes.apply(ctx(KPM_A), ops).then(
        () => { throw new Error('the batch was applied'); },
        (err: unknown) => err as { code: string; message: string },
      );
    const referralsExists = async () =>
      (await wired.activity.list(ctx(KPM_A), true)).some((c) => c.code === 'REFERRALS');

    it('refuses a benchmark out of range, and writes none of the ops ahead of it', async () => {
      const ratio = (await wired.ratios.list(ctx(KPM_A)))[0];
      const err = await refusedWith([
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'ratio.update', id: ratio.id, expectedVersion: ratio.version, body: { benchmark: 99999 } },
      ]);

      expect(err.code).toBe('VALIDATION_FAILED');
      expect(err.message).toBe('Change 2 (ratio.update): benchmark must be a number from 0 to 1000.');
      expect(await referralsExists()).toBe(false);
      expect((await wired.ratios.list(ctx(KPM_A)))[0].benchmark).toBe(ratio.benchmark);
    });

    it('refuses a label that is not text before anything is written, not while it is', async () => {
      const submission = await typeNamed('SELL_SUBMISSION');
      const err = await refusedWith([
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'type.update', id: submission.id, expectedVersion: submission.version, body: { label: 42 } },
      ]);

      expect(err.message).toBe('Change 2 (type.update): label must be text.');
      expect(await referralsExists()).toBe(false);
    });

    it('refuses a label longer than the single route would take', async () => {
      const err = await refusedWith([
        { op: 'category.create', body: { code: 'REFERRALS', label: 'x'.repeat(81) } },
      ]);
      expect(err.message).toBe('Change 1 (category.create): label must be 1–80 characters.');
      expect(await referralsExists()).toBe(false);
    });

    it('refuses a field no op accepts, where it used to be dropped in silence', async () => {
      const ratio = (await wired.ratios.list(ctx(KPM_A)))[0];
      const err = await refusedWith([
        { op: 'ratio.update', id: ratio.id, expectedVersion: ratio.version, body: { benchmrk: 0.2 } },
      ]);
      expect(err.message).toBe('Change 1 (ratio.update): property benchmrk should not exist');
    });

    it('refuses anything carried on an archive, which names a row and nothing more', async () => {
      const ratio = (await wired.ratios.list(ctx(KPM_A)))[0];
      const err = await refusedWith([
        { op: 'ratio.archive', id: ratio.id, expectedVersion: ratio.version, body: { label: 'x' } },
      ]);
      expect(err.message).toBe('Change 1 (ratio.archive): property label should not exist');
      expect((await wired.ratios.list(ctx(KPM_A)))[0].status).toBe('active');
    });
  });

  it('names the op when a rule the projection does not model refuses at apply time', async () => {
    /*
     * The residual this endpoint's docstring states: validation passes, and the service
     * refuses while applying. It is rare by construction and it is not impossible, and the
     * catch that names which op failed had never been exercised.
     */
    // An empty side used to stand in for such a rule here. Since ADR-0030 the validate pass
    // refuses that itself, so this names a type the office does not have: resolving a
    // formula's codes needs the activity types, which the projection does not hold.
    await expect(wired.changes.apply(ctx(KPM_A), [{
      op: 'ratio.create',
      body: {
        code: 'NO_SUCH_TYPE', label: 'Broken', numerator: ['NOT_A_TYPE'],
        denominator: ['SELL_SUBMISSION'], benchmark: 1, comparison: 'gte',
      },
    }])).rejects.toThrow(/Change 1 \(ratio.create\).*no active activity type/s);
  });

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

    it('refuses a display unit its rule cannot have before writing anything (P4-T25)', async () => {
      const rows = await wired.ratios.list(ctx(KPM_A));
      const leads = rows.find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      const band = rows.find((r) => r.code === 'SELLING_VS_RECRUITMENT')!;

      await expect(wired.changes.apply(ctx(KPM_A), [
        // Valid on its own, and must not land.
        { op: 'ratio.update', id: leads.id, expectedVersion: leads.version, body: { benchmark: 0.9 } },
        { op: 'ratio.update', id: band.id, expectedVersion: band.version, body: { displayUnit: 'percent' } },
      ])).rejects.toMatchObject({ code: 'CONFIG_RATIO_UNIT_MISMATCH' });

      expect((await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'LEADS_PER_ACTIVITY')!.benchmark)
        .toBe(leads.benchmark);
    });

    it('lets one op turn a ratio into a band and the next leave its unit alone', async () => {
      // The projection carries the rule forward, so the second op is judged against the
      // band the first one made — not against the row as it was read.
      const leads = (await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'ratio.update', id: leads.id, expectedVersion: leads.version, body: { comparison: 'band' } },
        { op: 'ratio.update', id: leads.id, expectedVersion: leads.version + 1, body: { benchmark: 25 } },
      ]);
      const after = (await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'LEADS_PER_ACTIVITY')!;
      expect(after).toMatchObject({ comparison: 'band', displayUnit: 'points', benchmark: 25 });
    });

    it('names which change failed, not just what went wrong', async () => {
      await expect(wired.changes.apply(ctx(KPM_A), [
        { op: 'category.create', body: { code: 'REFERRALS', label: 'Referrals' } },
        { op: 'type.create', body: { code: 'X_ONE', categoryCode: 'NOWHERE', label: 'x' } },
      ])).rejects.toMatchObject({ message: expect.stringContaining('Change 2 (type.create)') });
    });
  });

  it('applies a formula change on a provisioned ratio, and flags it (ADR-0024)', async () => {
    /*
     * The batch refused this until ADR-0024, alongside the service. Both are open now, and
     * the benchmark that used to be lost with the refusal lands in the same op.
     */
    const ratio = (await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE')!;

    await wired.changes.apply(ctx(KPM_A), [{
      op: 'ratio.update',
      id: ratio.id,
      expectedVersion: ratio.version,
      body: { benchmark: 0.9, numerator: ['SELL_PRESENTATION'] },
    }]);

    expect((await wired.ratios.list(ctx(KPM_A))).find((r) => r.code === 'SELLING_SUCCESS_RATE'))
      .toMatchObject({ benchmark: 0.9, numerator: ['SELL_PRESENTATION'], divergesFromStandard: true });
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
      const followUp = await typeNamed('SELL_FOLLOWUP');
      await wired.changes.apply(ctx(KPM_A), [
        { op: 'type.update', id: followUp.id, expectedVersion: followUp.version, body: { label: 'Closing' } },
        { op: 'type.archive', id: followUp.id, expectedVersion: followUp.version + 1 },
      ]);

      const after = await typeNamed('SELL_FOLLOWUP');
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
