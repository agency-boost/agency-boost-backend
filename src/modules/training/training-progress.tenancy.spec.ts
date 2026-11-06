import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  COMPANY_LINK, KPM_A, KPM_B, startTrainingHarness, stopTrainingHarness, type TrainingHarness, type Who,
} from '../../../test/training-office';

/**
 * **Training progress is the office's own** (P18.2-T1 AC-2, P18.2-T3 AC-7): office 0417 (`KPM_A`) against 0555
 * (`KPM_B`) on every route and every read — another office's module and another office's row are 404 and absent,
 * by HTTP through the real guard and by the services, and another office's progress never completes an item.
 *
 * Both offices hold the same seeded codes, so a code alone never tells them apart: every isolation here is the
 * repository's `kpmId`, not a code that happens to differ. `GADING_ONLY` is 0555's alone, published there.
 */
describe('training progress isolation (P18.2-T1 AC-2)', () => {
  let h: TrainingHarness;
  const id = (who: Who) => h.id(who);
  const rowInB = (membershipId: string, moduleCode: string, status = 'done') => h.col('trainingProgress').insertOne({
    kpmId: KPM_B, membershipId, moduleCode, status, startedAt: new Date('2026-09-01T03:00:00Z'),
    completedAt: status === 'done' ? new Date('2026-09-02T03:00:00Z') : null, opened: [{ itemId: COMPANY_LINK.id, at: new Date('2026-09-01T03:00:00Z') }],
    version: 2, deletedAt: null, createdBy: membershipId, updatedBy: membershipId,
  });

  beforeAll(async () => { h = await startTrainingHarness(); });
  afterAll(async () => { await stopTrainingHarness(h); });
  beforeEach(async () => {
    await h.reset();
    await h.wired.training.createModule(h.office.as('B_AB'), {
      code: 'GADING_ONLY', skillCode: 'CLOSING', title: 'Only in 0555', publishState: 'published',
    });
    await h.publish(KPM_B);
  });

  describe('another office’s module is 404 on every route', () => {
    it('P18.2-T1 AC-2 GET, open and PUT all answer 404 for 0555’s module to a member of 0417', async () => {
      h.as('RINA');
      await h.http().get('/training/modules/GADING_ONLY').expect(404);
      await h.http().post(`/training/modules/GADING_ONLY/items/${COMPANY_LINK.id}/open`).send({}).expect(404);
      await h.http().put('/training/modules/GADING_ONLY/progress').send({ status: 'done' }).expect(404);
      expect(await h.col('trainingProgress').countDocuments({ moduleCode: 'GADING_ONLY' })).toBe(0);
    });

    it('P18.2-T1 AC-2 and is absent from 0417’s read, while 0555’s own member is offered it', async () => {
      h.as('RINA');
      const a = (await h.http().get('/training/progress').expect(200)).body;
      expect(JSON.stringify(a)).not.toContain('GADING_ONLY');
      h.as('B_AGENT');
      await h.http().get('/training/modules/GADING_ONLY').expect(200);
    });
  });

  describe('another office’s row is never read nor written', () => {
    it('P18.2-T1 AC-2 a row in 0555 under a 0417 membership counts for nothing in 0417, and opens nothing', async () => {
      // A forged row: right membership, wrong office.
      await rowInB(id('RINA'), 'PROSPECT_LIST');
      h.as('RINA');
      const view = (await h.http().get('/training/progress').expect(200)).body;
      expect([view.done, view.total]).toEqual([0, 10]);
      const page = (await h.http().get('/training/modules/PROSPECT_LIST').expect(200)).body;
      expect(page).toMatchObject({ status: 'not_started', openedItemIds: [] });
    });

    it('P18.2-T1 AC-2 a write in 0417 makes 0417’s own row and leaves 0555’s untouched', async () => {
      await rowInB(id('RINA'), 'PROSPECT_LIST', 'in_progress');
      h.as('RINA');
      await h.http().put('/training/modules/PROSPECT_LIST/progress').send({ status: 'done' }).expect(200);
      const rows = await h.col('trainingProgress').find({ membershipId: id('RINA'), moduleCode: 'PROSPECT_LIST' }).sort({ kpmId: 1 }).toArray();
      expect(rows.map((r) => [r.kpmId, r.status])).toEqual([[KPM_A, 'done'], [KPM_B, 'in_progress']].sort());
    });

    it('P18.2-T4 AC-1 ?for= a member of another office is 404, and writes no entry', async () => {
      h.as('AGUS');
      await h.http().get(`/training/progress?for=${id('B_AGENT')}`).expect(404);
      h.as('OWNER');
      await h.http().get(`/training/progress?for=${id('B_AB')}`).expect(404);
      expect(await h.col('auditLog').countDocuments({ action: 'activity_log.read_raw' })).toBe(0);
    });

    it('P18.2-T2 AC-3 the readings answer nothing of another office, for many members at once', async () => {
      await rowInB(id('B_AGENT'), 'PROSPECT_LIST');
      await rowInB(id('RINA'), 'CLOSING_TECHNIQUES');
      const readings = h.wired.trainingReadings;
      const inA = h.office.as('AGUS');
      expect(await readings.rowsOf(inA, [id('B_AGENT'), id('RINA')])).toEqual([]);
      const many = await readings.ofMany(inA, [id('B_AGENT'), id('RINA')]);
      expect([...many.values()].map((v) => v.done)).toEqual([0, 0]);
      // And 0555 reads its own.
      expect((await readings.rowsOf(h.office.as('B_AB'), [id('B_AGENT')])).map((r) => r.moduleCode)).toEqual(['PROSPECT_LIST']);
    });

    it('P18.2-T1 AC-2 a query with no office fails closed rather than reading across offices', async () => {
      const noOffice = RequestContext.platform('root');
      await expect(h.wired.trainingReadings.rowsOf(noOffice, [id('RINA')])).rejects.toThrow(MissingTenantContextError);
      await expect(h.wired.trainingProgressRows.find(noOffice, {})).rejects.toThrow(MissingTenantContextError);
    });

    it('P18.2-T1 AC-2 the offered catalog is the office’s own snapshot', async () => {
      const a = await h.wired.offeredTraining.moduleCodes(h.office.as('RINA'));
      const b = await h.wired.offeredTraining.moduleCodes(h.office.as('B_AGENT'));
      expect(a.has('GADING_ONLY')).toBe(false);
      expect(b.has('GADING_ONLY')).toBe(true);
    });
  });

  describe('another office’s progress never completes an item (P18.2-T3 AC-7)', () => {
    it('P18.2-T3 AC-7 a done row in 0555 under the hire’s membership leaves the 0417 item waiting', async () => {
      const activation = await h.start('BUDI', '2026-07-15');
      await h.bind(activation, 'MANDATORY_TRAINING', 'training:CLOSING_TECHNIQUES');
      await rowInB(id('BUDI'), 'CLOSING_TECHNIQUES');

      const ctx = h.office.as('BUDI');
      const office = await new TenantDay(h.wired.kpms as never, h.clock).office(ctx);
      const [resolved] = await h.wired.activationProgress.resolve(ctx, [activation], office);
      expect(resolved.doc.items.find((i) => i.code === 'MANDATORY_TRAINING')!.done).toBe(false);

      // The hire's own, in their own office, does complete it.
      h.as('BUDI');
      await h.http().put('/training/modules/CLOSING_TECHNIQUES/progress').send({ status: 'done' }).expect(200);
      const [after] = await h.wired.activationProgress.resolve(ctx, [activation], office);
      expect(after.doc.items.find((i) => i.code === 'MANDATORY_TRAINING')).toMatchObject({ done: true, source: 'link' });
    });
  });

  describe('structure', () => {
    it('P18.2-T1 AC-2 the training services hold no raw model: every read and write goes through the repository', () => {
      for (const file of ['training-progress.service.ts', 'training-progress-readings.ts', 'offered-training.ts']) {
        const text = readFileSync(join(__dirname, file), 'utf8');
        expect([file, /@InjectModel\(/.test(text)]).toEqual([file, false]);
      }
    });

    it('P18.2-T1 AC-2 no write takes a subject: nobody sets another member’s status', () => {
      const text = readFileSync(join(__dirname, 'training-progress.service.ts'), 'utf8');
      // Every write reads its member from the caller's own membership.
      for (const method of ['async open(', 'async setStatus(']) {
        const body = text.slice(text.indexOf(method), text.indexOf('\n  }\n', text.indexOf(method)));
        expect([method, body.includes('requireMembership(ctx)')]).toEqual([method, true]);
      }
      expect(text).not.toMatch(/setStatus\([^)]*for/);
    });
  });
});
