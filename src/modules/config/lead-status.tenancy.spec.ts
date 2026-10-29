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


/** A published template row as provisioning is handed it: its payload and version, resolved first. */
const asSource = (row: { payload: Record<string, unknown>; version: number; [field: string]: unknown }) => ({
  payload: row.payload, seededFrom: { templateId: 'tpl-1', version: row.version },
});

describe('the office lead pipelines (P4-T3)', () => {
  let service: LeadStatusService;
  let provisioning: ProvisioningService;

  beforeAll(async () => {
    await startMongo();
    const wired = configModule(NOW);
    service = wired.leads;
    provisioning = wired.provisioning;
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  describe('the seeded ladders (AC-2)', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A));

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

  describe('the stages a lead is expected to close from (ADR-0043, AC-4)', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A));

    it('seeds the stages after which the work is the counterparty’s', async () => {
      /*
       * This is the whole of OD-12's second half. `RECRUITMENT_EXPECTED_TO_CLOSE` had no
       * source until this field existed, and the prototype's stub named *Offer* and
       * *Onboarding* — stages that appear in neither ladder.
       */
      const [sales, recruitment] = await service.list(ctx(KPM_A));

      expect(sales.statuses.filter((s) => s.isLateStage).map((s) => s.code))
        .toEqual(['POLICY_SUBMITTED', 'APPROVED_NOT_PAID']);
      expect(recruitment.statuses.filter((s) => s.isLateStage).map((s) => s.code))
        .toEqual(['AGENT_CODE_CREATED', 'AAJI_LICENSED', 'JOINT_FIELD_WORK_PLANNED']);
    });

    it('never flags the stage that closes a pipeline', async () => {
      // A lead that has closed is not expected to close; counting it would double it
      // against last period's figure.
      for (const pipeline of await service.list(ctx(KPM_A))) {
        expect(pipeline.statuses.find((s) => s.isTerminal)!.isLateStage).toBe(false);
      }
    });

    it('is a set, not an exclusive flag — unlike the terminal one', async () => {
      const [, recruitment] = await service.list(ctx(KPM_A));
      const target = recruitment.statuses.find((s) => s.code === 'MEETING_SCHEDULED')!;

      await service.setLateStage(ctx(KPM_A), target.id, true);

      const [, after] = await service.list(ctx(KPM_A));
      expect(after.statuses.filter((s) => s.isLateStage)).toHaveLength(4);
    });

    it('unticks, because an untick is as much a decision as a tick', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const submitted = sales.statuses.find((s) => s.code === 'POLICY_SUBMITTED')!;

      const updated = await service.setLateStage(ctx(KPM_A), submitted.id, false);

      expect(updated.isLateStage).toBe(false);
      expect(updated.version).toBe(submitted.version + 1);
    });

    it('refuses the terminal stage, and says where to put the flag instead', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const closed = sales.statuses.find((s) => s.isTerminal)!;

      await expect(service.setLateStage(ctx(KPM_A), closed.id, true))
        .rejects.toThrow(/already closed/);
    });

    it('refuses an archived stage, which holds no leads', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const followUp = sales.statuses.find((s) => s.code === 'FOLLOW_UP')!;
      await service.archive(ctx(KPM_A), followUp.id);

      await expect(service.setLateStage(ctx(KPM_A), followUp.id, true))
        .rejects.toThrow(/holds no leads/);
    });

    it('clears the flag when a late stage is made terminal', async () => {
      // Both cannot stand. The Owner's intent is unambiguous — they are naming the stage
      // that ends the pipeline — so it is cleared rather than refused.
      const [sales] = await service.list(ctx(KPM_A));
      const submitted = sales.statuses.find((s) => s.code === 'POLICY_SUBMITTED')!;
      expect(submitted.isLateStage).toBe(true);

      await service.setTerminal(ctx(KPM_A), submitted.id);

      const [after] = await service.list(ctx(KPM_A));
      const now = after.statuses.find((s) => s.code === 'POLICY_SUBMITTED')!;
      expect(now.isTerminal).toBe(true);
      expect(now.isLateStage).toBe(false);
    });

    it('writes nothing when the flag is already what was asked for', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const submitted = sales.statuses.find((s) => s.code === 'POLICY_SUBMITTED')!;

      const same = await service.setLateStage(ctx(KPM_A), submitted.id, true);

      expect(same.version).toBe(submitted.version);
    });

    it('cannot flag another office’s stage — 404, never 403', async () => {
      await provisioning.seedLeadPipelines(KPM_B);
      const [salesB] = await service.list(ctx(KPM_B));
      const theirs = salesB.statuses.find((s) => s.code === 'FOLLOW_UP')!;

      await expect(service.setLateStage(ctx(KPM_A), theirs.id, true))
        .rejects.toThrow(/Lead status/);
    });

    it('gives an office’s own new stage `false`, never a guess from its rank', async () => {
      // Deriving it from position is exactly what ADR-0043 refused. We know nothing about
      // a stage an office invented, so it counts nothing until somebody ticks the box.
      const created = await service.create(ctx(KPM_A), {
        pipeline: 'recruitment', code: 'CONTRACT_SENT', label: 'Contract sent',
      });

      expect(created.isLateStage).toBe(false);
    });
  });

  describe('changing a ladder', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A));

    it('renames a stage without touching the code every lead holds', async () => {
      const [sales] = await service.list(ctx(KPM_A));
      const stage = sales.statuses[0];
      const renamed = await service.rename(ctx(KPM_A), stage.id, 'Belum dihubungi');
      expect(renamed.label).toBe('Belum dihubungi');
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
      // A source as provisioning is handed it (ADR-0115 §4), from a template older than the check.
      const source = asSource({
        companyId: COMPANY, kind: 'lead_pipeline', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          statuses: [
            { pipeline: 'sales', code: 'ONE', label: 'One', rank: 1, isTerminal: false },
            { pipeline: 'recruitment', code: 'TWO', label: 'Two', rank: 1, isTerminal: true },
          ],
        },
      });

      await expect(provisioning.seedLeadPipelines(KPM_A, source))
        .rejects.toThrow(/sales pipeline has 0 terminal stages/);
    });

    it('refuses a template whose stage both closes and is expected to close', async () => {
      // Copying it would make *Expected to close* double-count against *Last month*, and
      // the bad number would surface on the Owner's Overview weeks later (ADR-0043).
      // A source as provisioning is handed it (ADR-0115 §4), from a template older than the check.
      const source = asSource({
        companyId: COMPANY, kind: 'lead_pipeline', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          statuses: [
            { pipeline: 'sales', code: 'ONE', label: 'One', rank: 1, isTerminal: true, isLateStage: true },
            { pipeline: 'recruitment', code: 'TWO', label: 'Two', rank: 1, isTerminal: true, isLateStage: false },
          ],
        },
      });

      await expect(provisioning.seedLeadPipelines(KPM_A, source))
        .rejects.toThrow(/ONE.*both/s);
    });

    it('keeps two offices’ ladders apart', async () => {
      await provisioning.seedLeadPipelines(KPM_A);
      await provisioning.seedLeadPipelines(KPM_B);
      const [sales] = await service.list(ctx(KPM_A));
      await service.rename(ctx(KPM_A), sales.statuses[0].id, 'Only in A');

      const [theirs] = await service.list(ctx(KPM_B));
      expect(theirs.statuses[0].label).toBe('Belum didekati');
    });

    it('cannot rename another office’s stage — 404, never 403', async () => {
      await provisioning.seedLeadPipelines(KPM_A);
      await provisioning.seedLeadPipelines(KPM_B);
      const [theirs] = await service.list(ctx(KPM_B));
      await expect(service.rename(ctx(KPM_A), theirs.statuses[0].id, 'mine'))
        .rejects.toThrow('Lead status');
    });
  });
  describe('the rest of the writes (P4-T12)', () => {
    beforeEach(() => provisioning.seedLeadPipelines(KPM_A));

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
      await provisioning.seedLeadPipelines(KPM_B);
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
      await provisioning.seedLeadPipelines(KPM_B);
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
