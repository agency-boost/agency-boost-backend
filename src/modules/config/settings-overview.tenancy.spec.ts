import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import type { KpmProductService } from '@/modules/products/kpm-product.service';
import type { BrandingReader } from '@/modules/branding/branding-reader';
import { SettingsOverviewService } from './settings-overview.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-11-20T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

type Over = Partial<{ isKpmOwner: boolean; isKpmAdmin: boolean; isCoreLeader: boolean; hierarchyRole: string; status: string }>;
function member(kpmId: string, over: Over = {}) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never);
}
const owner = (kpmId: string) => member(kpmId, { isKpmOwner: true });

/**
 * **Per-setting publishing and the Pengaturan hub's read** (P19.21-T2; ADR-0274 §5, §6), over the real services and a
 * real database: each setting's state and version, *Terbitkan* on one and *Terbitkan semua*, the activation checklist's
 * own draft, and the hub's counts and statuses — one KPM never reading or moving another's.
 */
describe('per-setting publishing and the Pengaturan hub (P19.21-T2)', () => {
  let wired: ReturnType<typeof configModule>;
  let products: { list: jest.Mock };
  let shown: { logo: unknown } | null;
  let hub: SettingsOverviewService;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    products = { list: jest.fn() };
    hub = new SettingsOverviewService(
      wired.config, wired.activity, wired.training, wired.capability, wired.activation,
      products as unknown as KpmProductService, wired.recruitmentPitch,
      { shownFor: async () => shown } as unknown as BrandingReader,
      wired.kpms as never,
    );
  });

  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
    await (wired.kpms as unknown as { create: (d: unknown) => Promise<unknown> }).create({
      _id: KPM_A, code: '0417', branchName: 'BSD City Branch', companyId: COMPANY, fiscalYearStartMonth: 1,
    });
    products.list.mockResolvedValue([]);
    shown = { logo: { key: 'k', width: 1, height: 1 } };
    await wired.config.publish(owner(KPM_A));
    await wired.config.publish(owner(KPM_B));
  });

  const stateOf = async (ctx: RequestContext, setting: string) =>
    (await wired.config.state(ctx)).settings.find((s) => s.setting === setting)!;
  const renameLeadStatus = async (ctx: RequestContext, label: string) => {
    const [pipeline] = await wired.leads.list(ctx);
    await wired.leads.rename(ctx, pipeline.statuses[0].id, label);
  };
  const renameType = async (ctx: RequestContext, label: string) => {
    const type = (await wired.activity.list(ctx)).flatMap((c) => c.types).find((t) => t.code === 'SELL_FOLLOWUP')!;
    await wired.activity.updateType(ctx, type.id, { label });
  };

  describe('each setting’s state (AC-3)', () => {
    it('P19.21-T2 AC-3 every setting starts published at version 1 with nothing waiting', async () => {
      const state = await wired.config.state(owner(KPM_A));
      expect(state.settings.map((s) => [s.setting, s.version, s.hasUnpublishedChanges])).toEqual([
        ['activity_types', 1, false], ['lead_statuses', 1, false], ['activation_checklist', 1, false],
        ['training', 1, false], ['capability_mapping', 1, false], ['events', 1, false],
      ]);
      expect(state.settings[0].publishedAt).toBe(NOW.toISOString());
      expect(state.hasUnpublishedChanges).toBe(false);
    });

    it('P19.21-T2 AC-3 an edit marks its own setting only', async () => {
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      const state = await wired.config.state(owner(KPM_A));
      expect(state.settings.filter((s) => s.hasUnpublishedChanges).map((s) => s.setting)).toEqual(['lead_statuses']);
      expect(state.hasUnpublishedChanges).toBe(true);
    });
  });

  describe('Terbitkan one setting (AC-3)', () => {
    it('P19.21-T2 AC-3 publishes that setting’s rows and keeps agents on every other setting as it was', async () => {
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      await renameType(owner(KPM_A), 'Diskusi lanjutan');

      const state = await wired.config.publish(owner(KPM_A), { source: 'kpm' }, ['lead_statuses']);
      expect(state.publishedVersion).toBe(2);
      expect(state.settings.find((s) => s.setting === 'lead_statuses')).toMatchObject({ version: 2, hasUnpublishedChanges: false });
      expect(state.settings.find((s) => s.setting === 'activity_types')).toMatchObject({ version: 1, hasUnpublishedChanges: true });

      const agents = await wired.config.readPublished(owner(KPM_A));
      expect(agents.leadPipelines[0].statuses[0].label).toBe('Belum didekati');
      expect(agents.activity.flatMap((c) => c.types).map((t) => t.label)).not.toContain('Diskusi lanjutan');
    });

    it('P19.21-T2 AC-3 Terbitkan semua publishes every setting with changes; an unchanged one keeps its version', async () => {
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      await renameType(owner(KPM_A), 'Diskusi lanjutan');
      const state = await wired.config.publish(owner(KPM_A));
      expect(state.settings.map((s) => [s.setting, s.version, s.hasUnpublishedChanges])).toEqual([
        ['activity_types', 2, false], ['lead_statuses', 2, false], ['activation_checklist', 1, false],
        ['training', 1, false], ['capability_mapping', 1, false], ['events', 1, false],
      ]);
      expect(await wired.config.readPublished(owner(KPM_A))).toEqual(await wired.config.read(owner(KPM_A)));
    });

    it('P19.21-T2 AC-3 audits which settings went out, and their versions', async () => {
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      await wired.config.publish(owner(KPM_A), { source: 'kpm' }, ['lead_statuses']);
      const rows = await mongoose.connection.collection('auditLog')
        .find({ action: 'tenant_config.published', kpmId: KPM_A }).sort({ _id: -1 }).limit(1).toArray();
      expect(rows[0].after).toMatchObject({
        settings: ['lead_statuses'], changed: ['lead_statuses'], settingVersions: { lead_statuses: 2, activity_types: 1 },
      });
    });
  });

  describe('the activation checklist’s own draft (AC-3)', () => {
    const draftOf = async (ctx: RequestContext) => {
      const { published } = await wired.activation.read(ctx);
      return {
        aspects: published!.aspects.map((aspect, i) => ({
          code: aspect.code,
          label: i === 0 ? `${aspect.label} (baru)` : aspect.label,
          items: aspect.items.map((item) => ({ code: item.code, label: item.label, autoLink: item.autoLink })),
        })),
      };
    };

    it('P19.21-T2 AC-3 a saved draft waits; Terbitkan publishes it as the next version new hires are given', async () => {
      await wired.activation.saveDraft(owner(KPM_A), await draftOf(owner(KPM_A)));
      expect(await stateOf(owner(KPM_A), 'activation_checklist')).toMatchObject({ version: 1, hasUnpublishedChanges: true });

      const state = await wired.config.publish(owner(KPM_A), { source: 'kpm' }, ['activation_checklist']);
      expect(state.settings.find((s) => s.setting === 'activation_checklist')).toMatchObject({ version: 2, hasUnpublishedChanges: false });
      expect((await wired.activation.read(owner(KPM_A))).published!.version).toBe(2);
      expect((await wired.config.readPublished(owner(KPM_A))).activationChecklist!.version).toBe(2);
    });

    it('P19.21-T2 AC-3 a template push or a sync never publishes an Owner’s checklist draft for them', async () => {
      await wired.activation.saveDraft(owner(KPM_A), await draftOf(owner(KPM_A)));
      await wired.config.publish(owner(KPM_A), { source: 'migration', migration: 'test' });
      expect((await wired.activation.read(owner(KPM_A))).published!.version).toBe(1);
      expect(await stateOf(owner(KPM_A), 'activation_checklist')).toMatchObject({ hasUnpublishedChanges: true });
    });

    it('P19.21-T2 AC-3 a draft saved unchanged is nothing to publish', async () => {
      const { published } = await wired.activation.read(owner(KPM_A));
      await wired.activation.saveDraft(owner(KPM_A), {
        aspects: published!.aspects.map((a) => ({
          code: a.code, label: a.label, items: a.items.map((i) => ({ code: i.code, label: i.label, autoLink: i.autoLink })),
        })),
      });
      expect(await stateOf(owner(KPM_A), 'activation_checklist')).toMatchObject({ hasUnpublishedChanges: false });
    });
  });

  describe('a snapshot from before P19.21', () => {
    it('P19.21-T2 AC-3 reads every setting at the snapshot’s version, and counts on from there', async () => {
      const db = mongoose.connection.collection('configSnapshots');
      await wired.config.publish(owner(KPM_A));
      await db.updateMany({ kpmId: KPM_A }, { $unset: { settingVersions: '', settingPublished: '' } });
      expect((await stateOf(owner(KPM_A), 'events')).version).toBe(2);
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      const state = await wired.config.publish(owner(KPM_A), { source: 'kpm' }, ['lead_statuses']);
      expect(state.settings.find((s) => s.setting === 'lead_statuses')!.version).toBe(3);
      expect(state.settings.find((s) => s.setting === 'events')!.version).toBe(2);
    });
  });

  describe('isolation', () => {
    it('P19.21-T2 cross-tenant: KPM A’s edit and publish never mark nor move KPM B’s settings', async () => {
      await renameLeadStatus(owner(KPM_A), 'Hanya di A');
      expect((await stateOf(owner(KPM_B), 'lead_statuses')).hasUnpublishedChanges).toBe(false);
      await wired.config.publish(owner(KPM_A), { source: 'kpm' }, ['lead_statuses']);
      expect((await stateOf(owner(KPM_B), 'lead_statuses')).version).toBe(1);
      const theirs = await wired.config.readPublished(owner(KPM_B));
      expect(theirs.leadPipelines.flatMap((p) => p.statuses).map((s) => s.label)).not.toContain('Hanya di A');
    });

    it('P19.21-T2 cross-tenant: KPM B’s hub counts its own and shows none of KPM A’s waiting changes', async () => {
      await renameType(owner(KPM_A), 'Hanya di A');
      expect((await hub.read(owner(KPM_A))).unpublished).toEqual(['activity_types']);
      expect((await hub.read(owner(KPM_B))).unpublished).toEqual([]);
    });
  });

  describe('the hub’s read (AC-1, AC-2)', () => {
    const row = async (ctx: RequestContext, setting: string) =>
      (await hub.read(ctx)).settings.find((s) => s.setting === setting)!;

    it('P19.21-T2 AC-1 lists the eleven settings in the hub’s order', async () => {
      expect((await hub.read(owner(KPM_A))).settings.map((s) => s.setting)).toEqual([
        'activity_types', 'lead_statuses', 'activation_checklist', 'training', 'capability_mapping', 'events',
        'campaigns', 'products', 'recruitment_pitch', 'branch_info', 'branding',
      ]);
    });

    it('P19.21-T2 AC-2 a setting that is fine carries no status at all', async () => {
      const view = await hub.read(owner(KPM_A));
      const statuses = Object.fromEntries(view.settings.map((s) => [s.setting, s.status]));
      expect(statuses).toMatchObject({
        activity_types: null, lead_statuses: null, activation_checklist: null, training: null, capability_mapping: null,
        events: null, campaigns: null, products: null, branch_info: null, branding: null,
      });
      expect(view.unpublished).toEqual([]);
    });

    it('P19.21-T2 AC-2 Belum diterbitkan on a setting with changes, and the bar names it', async () => {
      await renameType(owner(KPM_A), 'Diskusi lanjutan');
      await renameLeadStatus(owner(KPM_A), 'Belum didekati');
      const view = await hub.read(owner(KPM_A));
      expect(view.unpublished).toEqual(['activity_types', 'lead_statuses']);
      expect(view.settings[0].status).toEqual({ kind: 'unpublished' });
    });

    it('P19.21-T2 AC-2 n belum ada counts the pitch materials of the six with no file', async () => {
      expect((await row(owner(KPM_A), 'recruitment_pitch'))).toMatchObject({
        status: { kind: 'missing', count: 6 }, counts: { materials: 6 },
      });
    });

    it('P19.21-T2 AC-2 Logo belum ada while the KPM shows no logo of its own or its template’s', async () => {
      shown = { logo: null };
      expect((await row(owner(KPM_A), 'branding')).status).toEqual({ kind: 'no_logo' });
      shown = null;
      expect((await row(owner(KPM_A), 'branding')).status).toEqual({ kind: 'no_logo' });
    });

    it('P19.21-T2 AC-2 n menunggu counts scripts waiting — for a reader who may approve them, never one sent back', async () => {
      const base = { kind: 'base', sellable: true, active: { value: true, overridden: false } };
      products.list.mockResolvedValue([
        { ...base, reviewState: 'pending' }, { ...base, reviewState: 'pending' }, { ...base, reviewState: 'rejected' },
        { ...base, reviewState: 'approved', sellable: false }, { kind: 'rider', sellable: true, active: { value: true }, reviewState: 'none' },
      ]);
      expect(await row(owner(KPM_A), 'products')).toMatchObject({
        status: { kind: 'waiting', count: 2 }, counts: { products: 4, sold: 3 },
      });
      // The Super Admin inside the KPM is its Owner, and approves too.
      const sa = RequestContext.superAdminInKpm(RequestContext.platform('root'), KPM_A);
      expect((await row(sa, 'products')).status).toEqual({ kind: 'waiting', count: 2 });
    });

    it('P19.21-T2 AC-1 counts what each line says', async () => {
      const view = await hub.read(owner(KPM_A));
      const counts = Object.fromEntries(view.settings.map((s) => [s.setting, s.counts]));
      const types = (await wired.activity.list(owner(KPM_A)));
      expect(counts.activity_types).toMatchObject({
        activities: types.reduce((n, c) => n + c.types.length, 0), categories: types.length,
      });
      expect(counts.activation_checklist).toMatchObject({ version: 1 });
      expect(counts.capability_mapping.stages).toBeGreaterThan(0);
      expect(counts.training.categories).toBeGreaterThan(0);
      expect(counts.branch_info).toMatchObject({ kpmCode: '0417', fiscalYearStartMonth: 1 });
      expect(counts.events).toMatchObject({ activities: null, kpmCode: null });
    });
  });

  describe('who reads the hub (ADR-0268)', () => {
    it.each([
      ['the Owner', () => owner(KPM_A)],
      ['an Admin', () => member(KPM_A, { isKpmAdmin: true })],
      ['a core leader', () => member(KPM_A, { isCoreLeader: true })],
      ['the Super Admin inside the KPM', () => RequestContext.superAdminInKpm(RequestContext.platform('root'), KPM_A)],
    ])('P19.21-T2 AC-1 positive: %s', async (_who, ctx) => {
      await expect(hub.read(ctx())).resolves.toMatchObject({ unpublished: [] });
    });

    it.each([
      ['an AB', () => member(KPM_A)],
      ['an AAB', () => member(KPM_A, { hierarchyRole: 'aab' })],
      ['an agent', () => member(KPM_A, { hierarchyRole: 'agent' })],
      ['a core leader no longer active', () => member(KPM_A, { isCoreLeader: true, status: 'removed' })],
    ])('P19.21-T2 AC-1 negative: %s is answered 404', async (_who, ctx) => {
      const refused = await hub.read(ctx()).catch((e: DomainException) => e);
      expect(refused).toBeInstanceOf(DomainException);
      expect((refused as DomainException).getStatus()).toBe(404);
    });

    it('P19.21-T2 AC-1 negative: a Super Admin in no KPM is 403', async () => {
      const refused = await hub.read(RequestContext.platform('root')).catch((e: DomainException) => e);
      expect((refused as DomainException).getStatus()).toBe(403);
    });
  });
});
