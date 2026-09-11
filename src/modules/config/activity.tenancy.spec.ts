import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { SEED_ACTIVITY_TYPES } from '@/domain/constants';
import { ActivityCategory, ActivityCategorySchema } from './activity-category.schema';
import { ActivityType, ActivityTypeSchema } from './activity-type.schema';
import { LeadStatus, LeadStatusSchema } from './lead-status.schema';
import { PlatformTemplate, PlatformTemplateSchema } from './platform-template.schema';
import { ActivityCategoryRepository, ActivityTypeRepository } from './activity.repository';
import { ActivityConfigService } from './activity.service';
import { ProvisioningService } from './provisioning.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { RatioDefinition, RatioDefinitionSchema } from './ratio-definition.schema';

const NOW = new Date('2026-09-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string | null, opts: { owner?: boolean } = {}) {
  return new RequestContext('u1', kpmId ? 'none' : 'super_admin', kpmId ? {
    membershipId: `mem-${kpmId}`,
    kpmId,
    hierarchyRole: 'ab',
    status: 'active',
    isKpmOwner: opts.owner ?? true,
    isKpmAdmin: false,
    directCount: 0,
  } : null);
}

describe('the office activity taxonomy (P4-T1)', () => {
  let service: ActivityConfigService;
  let provisioning: ProvisioningService;
  let templates: mongoose.Model<never>;

  beforeAll(async () => {
    await startMongo();
    const categories = mongoose.model(ActivityCategory.name, ActivityCategorySchema);
    const types = mongoose.model(ActivityType.name, ActivityTypeSchema);
    templates = mongoose.model(PlatformTemplate.name, PlatformTemplateSchema) as never;
    const audit = new AuditService(
      mongoose.model(AuditLog.name, AuditLogSchema) as never,
    );
    service = new ActivityConfigService(
      new ActivityCategoryRepository(categories as never),
      new ActivityTypeRepository(types as never),
      audit,
      new FixedClock(NOW),
    );
    provisioning = new ProvisioningService(
      categories as never,
      types as never,
      mongoose.model(LeadStatus.name, LeadStatusSchema) as never,
      mongoose.model(RatioDefinition.name, RatioDefinitionSchema) as never,
      templates as never,
    );
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  describe('provisioning (AC-4, AC-5)', () => {
    it('seeds the platform defaults when the company has published nothing', async () => {
      /*
       * AC-5, and it is not a convenience. Refusing here would make the first office of
       * every new insurer unreachable — gated behind somebody remembering to publish a
       * preset before the office can exist at all.
       */
      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);

      expect(result.seededFromTemplateId).toBeNull();
      expect(result.types).toBe(SEED_ACTIVITY_TYPES.length);
      const taxonomy = await service.list(ctx(KPM_A));
      expect(taxonomy.map((c) => c.code)).toEqual([
        'LEADS_GENERATION', 'SELLING', 'RECRUITMENT',
        'PERSONAL_DEVELOPMENT', 'TEAM_DEVELOPMENT',
      ]);
      expect(taxonomy.flatMap((c) => c.types)).toHaveLength(12);
    });

    it('uses the company\'s own published template when there is one (AC-4)', async () => {
      await templates.create({
        companyId: COMPANY,
        kind: 'activity_taxonomy',
        version: 3,
        status: 'published',
        publishedAt: NOW,
        payload: {
          categories: [{ code: 'ONLY', label: 'Only', displayOrder: 1 }],
          types: [{
            code: 'ONLY_THING', categoryCode: 'ONLY', label: 'The only thing',
            description: null, displayOrder: 1,
          }],
        },
      } as never);

      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);

      expect(result.seededFromVersion).toBe(3);
      const taxonomy = await service.list(ctx(KPM_A));
      expect(taxonomy).toHaveLength(1);
      expect(taxonomy[0].types.map((t) => t.code)).toEqual(['ONLY_THING']);
    });

    it('takes the newest published version, not the newest row', async () => {
      const common = { companyId: COMPANY, kind: 'activity_taxonomy', publishedAt: NOW };
      await templates.create({
        ...common, version: 1, status: 'published',
        payload: { categories: [{ code: 'OLD', label: 'Old', displayOrder: 1 }], types: [] },
      } as never);
      await templates.create({
        ...common, version: 2, status: 'published',
        payload: { categories: [{ code: 'NEW', label: 'New', displayOrder: 1 }], types: [] },
      } as never);
      // A draft of 3 exists and must not be reached — publishing is the act that matters.
      await templates.create({
        ...common, version: 3, status: 'draft',
        payload: { categories: [{ code: 'DRAFT', label: 'Draft', displayOrder: 1 }], types: [] },
      } as never);

      await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      expect((await service.list(ctx(KPM_A))).map((c) => c.code)).toEqual(['NEW']);
    });

    it('does not copy a type whose category the template forgot to define', async () => {
      // It would render as a blank heading on the capture screen rather than as the bad
      // template it is.
      await templates.create({
        companyId: COMPANY, kind: 'activity_taxonomy', version: 1, status: 'published',
        publishedAt: NOW,
        payload: {
          categories: [{ code: 'REAL', label: 'Real', displayOrder: 1 }],
          types: [
            { code: 'KEPT', categoryCode: 'REAL', label: 'Kept', description: null, displayOrder: 1 },
            { code: 'ORPHAN', categoryCode: 'GONE', label: 'Orphan', description: null, displayOrder: 2 },
          ],
        },
      } as never);

      const result = await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      expect(result.types).toBe(1);
      expect((await service.list(ctx(KPM_A)))[0].types.map((t) => t.code)).toEqual(['KEPT']);
    });

    it('gives another company\'s office its own defaults, not this one\'s template', async () => {
      await templates.create({
        companyId: COMPANY, kind: 'activity_taxonomy', version: 1, status: 'published',
        publishedAt: NOW,
        payload: { categories: [{ code: 'PRU_ONLY', label: 'Pru', displayOrder: 1 }], types: [] },
      } as never);

      await provisioning.seedActivityTaxonomy(KPM_B, 'a-different-company');
      expect((await service.list(ctx(KPM_B))).map((c) => c.code)).not.toContain('PRU_ONLY');
    });
  });

  describe('isolation', () => {
    beforeEach(async () => {
      await provisioning.seedActivityTaxonomy(KPM_A, COMPANY);
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
    });

    it('shows an office its own taxonomy and nobody else\'s', async () => {
      await service.createType(ctx(KPM_A), {
        code: 'A_ONLY', categoryCode: 'SELLING', label: 'A only',
      });

      const a = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code);
      const b = (await service.list(ctx(KPM_B))).flatMap((c) => c.types).map((t) => t.code);
      expect(a).toContain('A_ONLY');
      expect(b).not.toContain('A_ONLY');
    });

    it('cannot archive another office\'s type — 404, never 403', async () => {
      // A 403 would confirm the id exists, which is itself tenant information.
      const theirs = (await service.list(ctx(KPM_B)))[0].types[0];
      await expect(service.archiveType(ctx(KPM_A), theirs.id)).rejects.toThrow('Activity type');
      expect((await service.list(ctx(KPM_B)))[0].types[0].status).toBe('active');
    });

    it('cannot rename another office\'s type', async () => {
      const theirs = (await service.list(ctx(KPM_B)))[0].types[0];
      await expect(service.updateType(ctx(KPM_A), theirs.id, { label: 'mine now' }))
        .rejects.toThrow('Activity type');
    });

    it('lets two offices hold the same code, meaning different things', async () => {
      // The whole point of Phase 4: uniqueness is per office, not per platform.
      await service.createType(ctx(KPM_A), {
        code: 'SHARED', categoryCode: 'SELLING', label: 'A’s version',
      });
      await expect(service.createType(ctx(KPM_B), {
        code: 'SHARED', categoryCode: 'SELLING', label: 'B’s version',
      })).resolves.toMatchObject({ code: 'SHARED' });
    });
  });

  describe('codes and order (AC-2, AC-6)', () => {
    beforeEach(() => provisioning.seedActivityTaxonomy(KPM_A, COMPANY));

    it('refuses a duplicate code, counting archived ones', async () => {
      // A retired code returning as something else would change the meaning of every
      // activity log still pointing at it.
      const type = (await service.list(ctx(KPM_A)))
        .flatMap((c) => c.types).find((t) => t.code === 'SELL_SUBMISSION')!;
      await service.archiveType(ctx(KPM_A), type.id);

      await expect(service.createType(ctx(KPM_A), {
        code: 'SELL_SUBMISSION', categoryCode: 'SELLING', label: 'Something else',
      })).rejects.toThrow('already has an activity type called SELL_SUBMISSION');
    });

    it('refuses a code that is not a code', async () => {
      await expect(service.createType(ctx(KPM_A), {
        code: 'no lowercase or spaces', categoryCode: 'SELLING', label: 'x',
      })).rejects.toThrow('3–40 characters');
    });

    it('refuses a type in a category the office does not have', async () => {
      await expect(service.createType(ctx(KPM_A), {
        code: 'HOMELESS', categoryCode: 'NOT_A_CATEGORY', label: 'x',
      })).rejects.toThrow('No active category called NOT_A_CATEGORY');
    });

    it('archives rather than deletes, and the row is still there to restore', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await service.archiveType(ctx(KPM_A), type.id);

      expect((await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code))
        .not.toContain(type.code);
      expect((await service.list(ctx(KPM_A), true)).flatMap((c) => c.types).map((t) => t.code))
        .toContain(type.code);

      await service.restoreType(ctx(KPM_A), type.id);
      expect((await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code))
        .toContain(type.code);
    });

    it('reorders by naming the whole list, and changes no code (AC-6)', async () => {
      const before = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      const reversed = [...before].reverse().map((t) => t.id);

      const after = await service.reorderTypes(ctx(KPM_A), reversed);

      expect(after.map((t) => t.code)).toEqual([...before].reverse().map((t) => t.code));
      // The identity did not move, which is the invariant: a reorder must rebind nothing.
      expect(new Set(after.map((t) => t.code))).toEqual(new Set(before.map((t) => t.code)));
      // And no version was bumped — dragging a row is not a change to what is counted.
      expect(after.every((t) => t.version === 1)).toBe(true);
    });

    it('refuses a partial reorder rather than guessing at the rest', async () => {
      const types = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      await expect(service.reorderTypes(ctx(KPM_A), [types[0].id]))
        .rejects.toThrow('every activity type, once each');
    });

    it('refuses a reorder naming another office\'s type', async () => {
      await provisioning.seedActivityTaxonomy(KPM_B, COMPANY);
      const mine = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.id);
      const theirs = (await service.list(ctx(KPM_B))).flatMap((c) => c.types)[0].id;
      await expect(service.reorderTypes(ctx(KPM_A), [...mine.slice(1), theirs]))
        .rejects.toThrow('every activity type, once each');
    });

    it('bumps the version when what the office counts actually changes', async () => {
      const type = (await service.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      const updated = await service.updateType(ctx(KPM_A), type.id, { label: 'Renamed' });
      expect(updated.version).toBe(2);
      expect(updated.code).toBe(type.code);
    });

    it('has no way to change a published code at all', () => {
      // Not "refuses" — the parameter does not exist. A code is what every activity log,
      // ratio formula and goal target holds.
      const update = service.updateType as unknown as (...args: unknown[]) => unknown;
      expect(update.length).toBe(3);
      const source = String(ActivityConfigService.prototype.updateType);
      expect(source).not.toMatch(/set\.code\s*=/);
    });
  });

  describe('the seeded taxonomy itself (AC-2, AC-3)', () => {
    beforeEach(() => provisioning.seedActivityTaxonomy(KPM_A, COMPANY));

    it('is the twelve codes the flow doc names, in display order', async () => {
      const codes = (await service.list(ctx(KPM_A))).flatMap((c) => c.types).map((t) => t.code);
      expect(codes).toEqual([
        'LEADS_GEN_ACTIVITY', 'LEADS_NEW_PROSPECT', 'LEADS_CONTACTED',
        'SELL_PRESENTATION', 'SELL_FOLLOWUP', 'SELL_SUBMISSION',
        'RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP', 'RECRUIT_AGENT_CODE',
        'DEV_TRAINING_ATTEND', 'DEV_COACHING_RECEIVED', 'DEV_TEAM_ACTIVITY',
      ]);
    });

    it('uses the KPM Owner wording where the two prototypes disagree (AC-3)', async () => {
      // The Owner app is the configuration screen — it depicts what an Owner edits — so
      // its wording is authoritative. The agent app has items 7–9 in English.
      const types = (await service.list(ctx(KPM_A))).flatMap((c) => c.types);
      const byCode = new Map(types.map((t) => [t.code, t]));
      expect(byCode.get('RECRUIT_PRESENTATION')!.label).toBe('Presentasi NBO ke calon agen');
      expect(byCode.get('RECRUIT_PRESENTATION')!.description)
        .toBe('secara mandiri atau melalui BOP');
      expect(byCode.get('RECRUIT_AGENT_CODE')!.label).toBe('Proses NPA');
    });

    it('carries the three codes the goal cascade binds to', async () => {
      // `LEADS_CONTACTED`, `SELL_PRESENTATION` and `SELL_SUBMISSION` — not items #3, #4
      // and #6 (invariant §4).
      const codes = await service.activeTypeCodes(ctx(KPM_A));
      expect(codes).toEqual(expect.arrayContaining([
        'LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION',
      ]));
    });
  });
});
