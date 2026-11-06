import { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { isRungMap, mapRungs } from './template-rungs';
import type { TemplateKinds } from './office-template';

/** Manulife's template as Allianz meets it: ratios and a section that name SBP and BP; Allianz's ladder is Agent → BP. */
const kinds = (): TemplateKinds => ({
  ratio_set: {
    ratios: [
      { code: 'R1', appliesToOrgLevelCodes: ['SBP', 'BP'] },
      { code: 'R2', appliesToOrgLevelCodes: ['sbp'] },
      { code: 'R3', appliesToOrgLevelCodes: [] },
    ],
  },
  activity_taxonomy: {
    categories: [{ code: 'LEADER', appliesToOrgLevelCodes: ['SBP'] }, { code: 'ALL' }],
    types: [],
  },
  recruitment_playbook: { nextAction: 'Teks saja: tidak menyebut jenjang.' },
});
const ALLIANZ = async () => ['AGENT', 'BP'];

async function refusal(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (err) {
    const e = err as DomainException;
    return { status: e.getStatus(), code: e.code, details: e.details, message: e.messageFor(readerIn('id')) };
  }
}

/**
 * **The rung map** (P19.4-T5 AC-4; ADR-0213 §4; the 11-03 handover's B1-7): *Salin dari…* onto a ladder that lacks a rung
 * the source names maps it to one the target has; every configuration naming it is rewritten, duplicates merged; one left
 * unmapped is still refused by name.
 */
describe('P19.4-T5 AC-4 mapRungs', () => {
  it('P19.4-T5 AC-4 an unmapped rung is still refused 409 TEMPLATE_RUNG_UNKNOWN, by name — "tidak memiliki SBP"', async () => {
    const refused = await refusal(mapRungs(kinds(), undefined, ALLIANZ, { refuseUnmapped: true }));
    expect(refused).toMatchObject({ status: 409, code: 'TEMPLATE_RUNG_UNKNOWN', details: { codes: ['SBP'] } });
    expect(refused!.message).toContain('tidak memiliki SBP');
  });

  it('P19.4-T5 AC-4 rewrites every configuration naming a mapped rung, merging the duplicate, and keeps the source as it was', async () => {
    const source = kinds();
    const { kinds: mapped, rungMap } = await mapRungs(source, { SBP: 'BP' }, ALLIANZ, { refuseUnmapped: true });
    expect(rungMap).toEqual({ SBP: 'BP' });
    const ratios = mapped.ratio_set!.ratios as { code: string; appliesToOrgLevelCodes: string[] }[];
    expect(ratios.map((r) => r.appliesToOrgLevelCodes)).toEqual([['BP'], ['BP'], []]);
    const sections = mapped.activity_taxonomy!.categories as { appliesToOrgLevelCodes: string[] }[];
    expect(sections.map((c) => c.appliesToOrgLevelCodes)).toEqual([['BP'], []]);
    // Text only: the playbook passes as it is (ADR-0210 §1).
    expect(mapped.recruitment_playbook).toBe(source.recruitment_playbook);
    expect((source.ratio_set!.ratios as { appliesToOrgLevelCodes: string[] }[])[0].appliesToOrgLevelCodes).toEqual(['SBP', 'BP']);
  });

  it('P19.4-T5 AC-4 a map to a code the target does not have live is 400 VALIDATION_FAILED, naming it', async () => {
    const refused = await refusal(mapRungs(kinds(), { SBP: 'SM' }, ALLIANZ, { refuseUnmapped: true }));
    expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', details: { field: 'rungMap', codes: ['SM'] } });
    expect(refused!.message).toContain('SM');
  });

  it('P19.4-T5 AC-4 ignores an entry for a rung the target has, and one the source never names', async () => {
    const { rungMap } = await mapRungs(kinds(), { SBP: 'BP', BP: 'AGENT', XX: 'BP' }, ALLIANZ, { refuseUnmapped: true });
    expect(rungMap).toEqual({ SBP: 'BP' });
  });

  it('P19.4-T5 AC-4 skips a blank or missing rung code in a list, and maps a kind written without its list as an empty one', async () => {
    const source: TemplateKinds = {
      ratio_set: { ratios: [{ code: 'R1', appliesToOrgLevelCodes: ['SBP', ' ', null] }] },
      activity_taxonomy: { types: [] },
    };
    const { kinds: mapped } = await mapRungs(source, { SBP: 'BP' }, ALLIANZ, { refuseUnmapped: true });
    expect((mapped.ratio_set!.ratios as { appliesToOrgLevelCodes: string[] }[])[0].appliesToOrgLevelCodes).toEqual(['BP']);
    expect(mapped.activity_taxonomy).toEqual({ types: [], categories: [] });
    const sectionsOnly: TemplateKinds = { ratio_set: {}, activity_taxonomy: { categories: [{ code: 'LEADER', appliesToOrgLevelCodes: ['SBP'] }] } };
    const moved = await mapRungs(sectionsOnly, { SBP: 'BP' }, ALLIANZ, { refuseUnmapped: true });
    expect(moved.kinds.ratio_set).toEqual({ ratios: [] });
    expect((moved.kinds.activity_taxonomy!.categories as { appliesToOrgLevelCodes: string[] }[])[0].appliesToOrgLevelCodes).toEqual(['BP']);
  });

  it('P19.4-T5 AC-4 reads no ladder for a copy that names no rung and sends no map', async () => {
    const ladder = jest.fn(ALLIANZ);
    const plain: TemplateKinds = { event_types: { types: [] } };
    expect(await mapRungs(plain, {}, ladder, { refuseUnmapped: true })).toEqual({ kinds: plain, rungMap: {} });
    expect(ladder).not.toHaveBeenCalled();
  });

  it('P19.4-T5 AC-4 within a company nothing is refused for a rung left unmapped; a map still moves one', async () => {
    const kept = await mapRungs(kinds(), undefined, ALLIANZ, { refuseUnmapped: false });
    expect((kept.kinds.ratio_set!.ratios as { appliesToOrgLevelCodes: string[] }[])[0].appliesToOrgLevelCodes).toEqual(['SBP', 'BP']);
    const moved = await mapRungs(kinds(), { sbp: 'bp' }, ALLIANZ, { refuseUnmapped: false });
    expect(moved.rungMap).toEqual({ SBP: 'BP' });
  });

  it('P19.4-T5 AC-4 a map is an object of codes and nothing else', () => {
    expect(isRungMap({ SBP: 'BP' })).toBe(true);
    expect(isRungMap({})).toBe(true);
    for (const bad of [null, [], 'SBP', { SBP: 1 }, { SBP: ' ' }, { ' ': 'BP' }]) expect(isRungMap(bad)).toBe(false);
  });
});
