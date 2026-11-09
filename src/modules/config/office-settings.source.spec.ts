import { RequestContext } from '@/common/context/request-context';
import { OfficeSettingsSource } from './office-settings.source';

const sa = RequestContext.platform('root');
const KPM = '66f0000000000000000000a1';

/** A document as a repository answers it: its row, and `toObject`. */
const doc = (row: Record<string, unknown>) => ({ ...row, toObject: () => ({ ...row }) });

/** A configuration repository's named cross-tenant read, answering `rows`. */
const reading = (rows: Record<string, unknown>[] = []) => ({ findInOfficeAcrossTenants: jest.fn(async () => rows.map(doc)) });

function source(over: {
  snapshots?: ReturnType<typeof reading>; checklists?: ReturnType<typeof reading>; modules?: ReturnType<typeof reading>;
  bindings?: ReturnType<typeof reading>;
} = {}) {
  const parts = {
    snapshots: over.snapshots ?? reading(), checklists: over.checklists ?? reading(), modules: over.modules ?? reading(),
    assets: reading(),
  };
  const built = over.bindings
    ? new OfficeSettingsSource(parts.snapshots as never, parts.checklists as never, parts.modules as never, parts.assets as never, over.bindings as never)
    // A hand-built instance with no binding repository: the snapshot's copy is what crosses.
    : new OfficeSettingsSource(parts.snapshots as never, parts.checklists as never, parts.modules as never, parts.assets as never);
  return { built, ...parts };
}

/**
 * **One office's published settings, as *Save as template* reads them** (P13.2-T7 AC-2, ADR-0115 §5; ADR-0163 §1): the
 * newest snapshot, the newest published checklist, the live binding, and the content of the modules the snapshot offers
 * — and nothing the office has not published.
 */
describe('P13.2-T7 OfficeSettingsSource.publishedSettingsOf', () => {
  it('P13.2-T7 AC-2 an office that has published nothing reads as nothing, and no module content is asked for', async () => {
    const { built, modules } = source();
    expect(await built.publishedSettingsOf(sa, KPM)).toEqual({ snapshot: null, binding: null, checklist: null, moduleContent: [] });
    expect(modules.findInOfficeAcrossTenants).not.toHaveBeenCalled();
  });

  it('P13.2-T7 AC-2 asks only for the modules the snapshot offers, each with its content or none', async () => {
    const payload = {
      training: [
        { code: 'CAT', skills: [{ code: 'SK', modules: [{ code: 'MOD_A' }, { code: 'MOD_B' }] }, { code: 'SK_EMPTY' }] },
        { code: 'CAT_EMPTY' },
      ],
    };
    const modules = reading([
      { code: 'MOD_A', companyContent: { files: [], videos: [], links: [{ id: 'l', label: 'Baca', url: 'https://x.test' }] } },
      { code: 'MOD_B' },
    ]);
    const { built } = source({ snapshots: reading([{ version: 4, payload }]), modules });
    const settings = await built.publishedSettingsOf(sa, KPM);
    expect(modules.findInOfficeAcrossTenants).toHaveBeenCalledWith(sa, KPM, { code: { $in: ['MOD_A', 'MOD_B'] } });
    expect(settings.snapshot).toEqual(payload);
    expect(settings.moduleContent).toEqual([
      { code: 'MOD_A', companyContent: { files: [], videos: [], links: [{ id: 'l', label: 'Baca', url: 'https://x.test' }] }, officeContent: null },
      { code: 'MOD_B', companyContent: null, officeContent: null },
    ]);
  });

  it('P13.2-T7 AC-2 a snapshot that offers no training asks for no module content', async () => {
    const modules = reading();
    const { built } = source({ snapshots: reading([{ version: 1, payload: { activity: [] } }]), modules });
    expect((await built.publishedSettingsOf(sa, KPM)).moduleContent).toEqual([]);
    expect(modules.findInOfficeAcrossTenants).not.toHaveBeenCalled();
  });

  it('ADR-0163 §1 the office’s live binding and its newest published checklist cross, read across tenants by name', async () => {
    const aspects = [{ code: 'A', label: 'Aspek', displayOrder: 1, items: [] }];
    const checklists = reading([{ status: 'published', version: 3, aspects }]);
    const bindings = reading([{ leads: ['L'], appointments: ['P'], closings: ['C'], status: 'active' }]);
    const { built } = source({ checklists, bindings });
    const settings = await built.publishedSettingsOf(sa, KPM);
    expect(settings.binding).toEqual({ leads: ['L'], appointments: ['P'], closings: ['C'] });
    expect(settings.checklist).toMatchObject({ version: 3, aspects });
    expect(checklists.findInOfficeAcrossTenants).toHaveBeenCalledWith(sa, KPM, { status: 'published' }, { sort: { version: -1 }, limit: 1 });
    expect(bindings.findInOfficeAcrossTenants).toHaveBeenCalledWith(sa, KPM, { status: 'active' }, { limit: 1 });
  });

  it('P13.2-T7 AC-3 asks the asset registry for no file when the template names none', async () => {
    const { built, assets } = source();
    expect(await built.officeFiles(sa, KPM, [])).toEqual([]);
    expect(assets.findInOfficeAcrossTenants).not.toHaveBeenCalled();
  });
});
