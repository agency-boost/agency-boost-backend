import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { LeadStatusService } from './lead-status.service';
import { ProvisioningService } from './provisioning.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });
}

describe('the office lead pipelines (P4-T3)', () => {
  let service: LeadStatusService;
  let provisioning: ProvisioningService;
  let templates: mongoose.Model<never>;

  beforeAll(async () => {
    await startMongo();
    const wired = configModule(NOW);
    service = wired.leads;
    provisioning = wired.provisioning;
    templates = wired.templates as never;
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  describe('the seeded ladders (AC-2)', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A, COMPANY));

    it('is five sales stages and seven recruitment ones, by code', async () => {
      const [sales, recruitment] = await service.list(ctx(KPM_A));
      expect(sales.statuses.map((s) => s.code)).toEqual([
        'NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED',
        'APPROVED_NOT_PAID', 'PAID_AND_ISSUED',
      ]);
      expect(recruitment.statuses).toHaveLength(7);
      expect(recruitment.statuses.at(-1)!.code).toBe('NEW_ACTIVE_AGENT');
    });

    it('gives each pipeline exactly one terminal stage (AC-3)', async () => {
      // *Mark successful* is gated on it: two would be ambiguous, none unreachable.
      for (const pipeline of await service.list(ctx(KPM_A))) {
        expect(pipeline.statuses.filter((s) => s.isTerminal)).toHaveLength(1);
      }
    });

    it('marks the terminal stage as a property, not as the last row', async () => {
      /*
       * The prototype compares against the end of a hardcoded array. An office adding a
       * stage after *Paid and issued* would silently move the gate — so a new stage is
       * appended and is deliberately not terminal.
       */
      await service.create(ctx(KPM_A), {
        pipeline: 'sales', code: 'AFTER_THE_END', label: 'After the end',
      });
      const [sales] = await service.list(ctx(KPM_A));
      expect(sales.statuses.at(-1)!.code).toBe('AFTER_THE_END');
      expect(sales.statuses.at(-1)!.isTerminal).toBe(false);
      expect(sales.statuses.find((s) => s.isTerminal)!.code).toBe('PAID_AND_ISSUED');
    });
  });

  describe('changing a ladder', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A, COMPANY));

    it('renames a stage without touching the code every lead holds', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses[0];
      const renamed = await service.rename(ctx(KPM_A), stage.id, 'Belum didekati');
      expect(renamed.label).toBe('Belum didekati');
      expect(renamed.code).toBe(stage.code);
    });

    it('refuses a blank name on the service itself, and keeps the one it had (ADR-0030)', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses[0];
      await expect(service.rename(ctx(KPM_A), stage.id, '   '))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const [after] = await service.list(ctx(KPM_A));
      expect(after.statuses[0].label).toBe(stage.label);
    });

    it('moves the terminal flag, leaving exactly one behind', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const submitted = sales.statuses.find((s) => s.code === 'POLICY_SUBMITTED')!;

      const after = await service.setTerminal(ctx(KPM_A), submitted.id);
      const terminals = after.statuses.filter((s) => s.isTerminal);
      expect(terminals).toHaveLength(1);
      expect(terminals[0].code).toBe('POLICY_SUBMITTED');
    });

    it('refuses to archive the stage that closes the pipeline', async () => {
      // Leads would have no way to be marked successful, and nothing on the leads screen
      // would say why the tick stopped working.
      const [sales] = await service.list(ctx(KPM_A));
      const terminal = sales.statuses.find((s) => s.isTerminal)!;
      await expect(service.archive(ctx(KPM_A), terminal.id))
        .rejects.toThrow('Make another one terminal first');
    });

    it('refuses to make an archived stage the terminal one', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses[1];
      await service.archive(ctx(KPM_A), stage.id);
      await expect(service.setTerminal(ctx(KPM_A), stage.id))
        .rejects.toThrow('archived status cannot be the one that closes');
    });

    it('refuses a duplicate code across both pipelines, not just within one', async () => {
      // A lead carries a status code and a type; one code meaning two things in one
      // office would make the first cross-pipeline report guess which.
      await expect(service.create(ctx(KPM_A), {
        pipeline: 'recruitment', code: 'FOLLOW_UP', label: 'Follow-up',
      })).rejects.toThrow('already has a lead status called FOLLOW_UP');
    });

    it('reorders one pipeline and leaves the other alone', async () => {
      const before = await service.list(ctx(KPM_A));
      const salesIds = [...before[0].statuses].reverse().map((s) => s.id);

      const after = await service.reorder(ctx(KPM_A), 'sales', salesIds);
      expect(after.statuses.map((s) => s.code))
        .toEqual([...before[0].statuses].reverse().map((s) => s.code));
      const [, recruitment] = await service.list(ctx(KPM_A));
      expect(recruitment.statuses.map((s) => s.code))
        .toEqual(before[1].statuses.map((s) => s.code));
    });

    it('refuses a reorder that does not name the whole pipeline', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      await expect(service.reorder(ctx(KPM_A), 'sales', [sales.statuses[0].id]))
        .rejects.toThrow('every sales status, once each');
    });
  });

  describe('provisioning and isolation', () => {
    it('refuses a template whose pipeline can never be closed', async () => {
      /*
       * A pipeline with no terminal stage looks like a leads bug for weeks before anybody
       * traces it back to a template — so it is refused at the moment of copying, where
       * the bad template is still the obvious suspect.
       */
      await templates.create({
        companyId: COMPANY, kind: 'lead_pipeline', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          statuses: [
            { pipeline: 'sales', code: 'ONE', label: 'One', rank: 1, isTerminal: false },
            { pipeline: 'recruitment', code: 'TWO', label: 'Two', rank: 1, isTerminal: true },
          ],
        },
      } as never);

      await expect(provisioning.seedLeadPipelines(KPM_A, COMPANY))
        .rejects.toThrow(/sales pipeline 0 terminal stages/);
    });

    it('keeps two offices’ ladders apart', async () => {
      await provisioning.seedLeadPipelines(KPM_A, COMPANY);
      await provisioning.seedLeadPipelines(KPM_B, COMPANY);
      const [sales] = await service.list(ctx(KPM_A));
      await service.rename(ctx(KPM_A), sales.statuses[0].id, 'Only in A');

      const [theirs] = await service.list(ctx(KPM_B));
      expect(theirs.statuses[0].label).toBe('Not yet approached');
    });

    it('cannot rename another office’s stage — 404, never 403', async () => {
      await provisioning.seedLeadPipelines(KPM_A, COMPANY);
      await provisioning.seedLeadPipelines(KPM_B, COMPANY);
      const [theirs] = await service.list(ctx(KPM_B));
      await expect(service.rename(ctx(KPM_A), theirs.statuses[0].id, 'mine'))
        .rejects.toThrow('Lead status');
    });
  });
  describe('the rest of the writes (P4-T12)', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A, COMPANY));

    it('normalises a new stage’s code', async () => {
      const created = await service.create(ctx(KPM_A), {
        pipeline: 'sales', code: '  awaiting_underwriting  ', label: '  Menunggu UW  ',
      });
      expect(created.code).toBe('AWAITING_UNDERWRITING');
      expect(created.label).toBe('Menunggu UW');
    });

    it('refuses a code that is not a code', async () => {
      await expect(service.create(ctx(KPM_A), {
        pipeline: 'sales', code: 'has spaces', label: 'x',
      })).rejects.toThrow('3–40 characters');
    });

    it('archives a non-terminal stage and brings it back', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses.find((s) => !s.isTerminal)!;

      const archived = await service.archive(ctx(KPM_A), stage.id);
      expect(archived.status).toBe('archived');

      const restored = await service.restore(ctx(KPM_A), stage.id);
      expect(restored.status).toBe('active');
      expect(restored.code).toBe(stage.code);
    });

    it('refuses to archive, restore or make terminal a stage that is not this office’s', async () => {
      await provisioning.seedLeadPipelines(KPM_B, COMPANY);
      const [theirs] = await service.list(ctx(KPM_B));
      const stage = theirs.statuses.find((s) => !s.isTerminal)!;

      await expect(service.archive(ctx(KPM_A), stage.id)).rejects.toThrow('Lead status');
      await expect(service.restore(ctx(KPM_A), stage.id)).rejects.toThrow('Lead status');
      await expect(service.setTerminal(ctx(KPM_A), stage.id)).rejects.toThrow('Lead status');
    });

    it('leaves the terminal flag alone when it is already on that stage', async () => {
      // Setting it to where it is should not churn versions on every other row.
      const [sales] = await service.list(ctx(KPM_A));
      const terminal = sales.statuses.find((s) => s.isTerminal)!;
      const after = await service.setTerminal(ctx(KPM_A), terminal.id);
      expect(after.statuses.filter((s) => s.isTerminal)).toHaveLength(1);
      expect(after.statuses.find((s) => s.isTerminal)!.code).toBe(terminal.code);
    });

    it('refuses to rename a stage that is not this office’s', async () => {
      await provisioning.seedLeadPipelines(KPM_B, COMPANY);
      const [theirs] = await service.list(ctx(KPM_B));
      await expect(service.rename(ctx(KPM_A), theirs.statuses[0].id, 'mine'))
        .rejects.toThrow('Lead status');
    });

    it('includes archived stages when asked, and not otherwise', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses.find((s) => !s.isTerminal)!;
      await service.archive(ctx(KPM_A), stage.id);

      const [withoutArchived] = await service.list(ctx(KPM_A));
      const [withArchived] = await service.list(ctx(KPM_A), true);
      expect(withoutArchived.statuses.map((s) => s.code)).not.toContain(stage.code);
      expect(withArchived.statuses.map((s) => s.code)).toContain(stage.code);
    });
  });

});
