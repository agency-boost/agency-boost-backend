import mongoose from 'mongoose';
import { ANALYTICS_SECTION_KODES, ANALYTICS_SYSTEM_KODES } from '@/domain/constants';
import { TEMPLATE_HEADER_V1, TEMPLATE_HEADER_V2 } from '@/modules/production/production-template';
import { analyticsViolations, type AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0057-advanced-analytics-v1';

const NOW = new Date('2026-11-05T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const LIBRARY = '66f0000000000000000000c9';
const PRU_DEFAULT = '66f0000000000000000000d1';
const PRU_JAKARTA = '66f0000000000000000000d2';
const PRU_ARCHIVED = '66f0000000000000000000d3';
const ALZ_DEFAULT = '66f0000000000000000000d4';
const LIB_DEFAULT = '66f0000000000000000000d5';
const KPM_A = '66f0000000000000000000a1'; // Prudential, its default
const KPM_B = '66f0000000000000000000a2'; // Prudential, Jakarta
const KPM_C = '66f0000000000000000000a3'; // Prudential, made from the library: reads its company's default
const KPM_D = '66f0000000000000000000a4'; // Allianz

/**
 * **`0057-advanced-analytics-v1`** (P19.5-T1 AC-3; ADR-0214 §9): every template — archived ones too — a published
 * version 1 equal to today's seven upload columns, its pattern the first every registered code of its KPMs matches, its
 * columns starting at the earliest month held; Prudential's §3 seed as a draft beside it; idempotent.
 */
describe('0057-advanced-analytics-v1 (ADR-0214 §9)', () => {
  const db = () => mongoose.connection.db!;
  const col = (name: string) => db().collection(name);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  beforeAll(startMongo, 120_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    // Raw collections no model registers: cleared by name.
    for (const name of ['companies', 'templates', 'kpms', 'memberships', 'monthlyAgentData', 'companyTemplates']) {
      await col(name).deleteMany({});
    }
    await col('companies').insertMany([
      { _id: oid(PRUDENTIAL), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: oid(ALLIANZ), name: 'Allianz Life', slug: 'allianz', kind: 'insurer', deletedAt: null },
      { _id: oid(LIBRARY), name: 'Template', slug: 'template', kind: 'template', deletedAt: null },
    ]);
    const template = (id: string, companyId: string, name: string, over: Record<string, unknown> = {}) => ({
      _id: oid(id), companyId, name, isDefault: false, status: 'active', deletedAt: null, ...over,
    });
    await col('templates').insertMany([
      template(PRU_DEFAULT, PRUDENTIAL, 'Prudential template', { isDefault: true }),
      template(PRU_JAKARTA, PRUDENTIAL, 'Jakarta'),
      template(PRU_ARCHIVED, PRUDENTIAL, 'Old', { status: 'archived' }),
      template(ALZ_DEFAULT, ALLIANZ, 'Allianz template', { isDefault: true }),
      template(LIB_DEFAULT, LIBRARY, 'Default template', { isDefault: true }),
    ]);
    const office = (id: string, companyId: string, startedFrom: Record<string, unknown> | null) =>
      ({ _id: oid(id), companyId, code: id.slice(-4), branchName: 'Branch', startedFrom, deletedAt: null });
    await col('kpms').insertMany([
      office(KPM_A, PRUDENTIAL, { source: 'template', templateId: PRU_DEFAULT, templateName: 'Prudential template' }),
      office(KPM_B, PRUDENTIAL, { source: 'template', templateId: PRU_JAKARTA, templateName: 'Jakarta' }),
      office(KPM_C, PRUDENTIAL, { source: 'template', templateId: LIB_DEFAULT, templateName: 'Default', companyId: LIBRARY }),
      office(KPM_D, ALLIANZ, null),
    ]);
    const member = (kpmId: string, agentCode: string, status = 'active') =>
      ({ kpmId, agentCode, status, userId: `u-${agentCode}`, deletedAt: null });
    await col('memberships').insertMany([
      member(KPM_A, '80777'), member(KPM_A, '12345'), member(KPM_C, '00012'),
      // Jakarta's KPM holds a code with letters: the second pattern.
      member(KPM_B, '80555'), member(KPM_B, 'KPM0417-001'),
      // Allianz: a code with a space — only the last pattern takes it. A removed member's code is not registered.
      member(KPM_D, 'AL 001'), member(KPM_D, 'gone code!', 'removed'),
    ]);
    const cell = (value: number | null) => ({ value, provenance: value === null ? null : 'imported' });
    await col('monthlyAgentData').insertMany([
      { kpmId: KPM_A, membershipId: 'm1', agentCode: '80777', month: '2025-03', apeMonthly: cell(1_000_00), deletedAt: null },
      { kpmId: KPM_A, membershipId: 'm1', agentCode: '80777', month: '2024-11', apeMonthly: cell(null), deletedAt: null },
      { kpmId: KPM_C, membershipId: 'm2', agentCode: '00012', month: '2025-01', policyCountMonthly: cell(2), deletedAt: null },
      { kpmId: KPM_B, membershipId: 'm3', agentCode: '80555', month: '2026-02', unitPersistencyMonthly: cell(90), deletedAt: null },
    ]);
  });

  const sectionOf = async (templateId: string, status = 'published') => col('companyTemplates')
    .findOne({ templateId, kind: 'advanced_analytics', status, deletedAt: null });

  it('P19.5-T1 AC-3 gives every template a published version 1 of today’s seven columns, archived ones too', async () => {
    const result = await up(db(), NOW);
    expect(result).toMatchObject({ written: 5, current: 0, drafts: 1 });
    for (const id of [PRU_DEFAULT, PRU_JAKARTA, PRU_ARCHIVED, ALZ_DEFAULT, LIB_DEFAULT]) {
      const row = await sectionOf(id);
      expect(row).toMatchObject({ version: 1, revision: 1, status: 'published' });
      const config = row!.payload as AdvancedAnalyticsConfig;
      expect(analyticsViolations(config)).toEqual([]);
      expect(config.uploadFields.map((f) => f.kode)).toEqual([
        'APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'FYP', 'POLICY_COUNT', 'UNIT_PERSISTENCY',
      ]);
      // The four system kodes are among them; nothing is required, so no KPM's upload changes until a publish.
      expect(config.uploadFields.filter((f) => f.system).map((f) => f.kode).sort()).toEqual([...ANALYTICS_SYSTEM_KODES].sort());
      expect(config.uploadFields.every((f) => f.required === false)).toBe(true);
      expect(config.uploadFields.find((f) => f.kode === 'UNIT_PERSISTENCY')).toMatchObject({ rows: 'leaders', unit: 'percent' });
      expect(config.uploadRules).toMatchObject({ unknownAgent: 'reject', completePct: 90, ytdTolerancePct: 1, historyMonthsBeforeJoin: 12 });
      expect(config.sections).toEqual(ANALYTICS_SECTION_KODES.map((kode) => ({ kode, enabled: true })));
    }
  });

  it('P19.5-T1 AC-3 keeps every header this product issued as an alias, so today’s files import unchanged', async () => {
    await up(db(), NOW);
    const config = (await sectionOf(PRU_DEFAULT))!.payload as AdvancedAnalyticsConfig;
    const aliases = config.uploadFields.flatMap((f) => f.labelAliases);
    const issued = [...TEMPLATE_HEADER_V1, ...TEMPLATE_HEADER_V2].filter((h) => h !== 'Agent Code' && h !== 'Agent Name');
    for (const header of issued) expect(aliases).toContain(header);
    for (const label of ['APE (Rp M)', 'Rolling Persistency (%)', 'Recruitment', 'New Active Agents', 'FYP (Rp M)', '# of Policy']) {
      expect(aliases).toContain(label);
    }
  });

  it('P19.5-T1 AC-3 chooses the first pattern every registered code on the template’s KPMs matches, and reports it', async () => {
    const result = await up(db(), NOW);
    const pattern = async (id: string) => ((await sectionOf(id))!.payload as AdvancedAnalyticsConfig).uploadRules;
    // Prudential's default answers for 0001 and for the KPM made from the library's template.
    expect(await pattern(PRU_DEFAULT)).toMatchObject({ agentCodePattern: '^\\d{3,32}$', agentCodeExample: '00012' });
    expect(await pattern(PRU_JAKARTA)).toMatchObject({ agentCodePattern: '^[A-Za-z0-9-]{1,32}$' });
    expect(await pattern(ALZ_DEFAULT)).toMatchObject({ agentCodePattern: '^.{1,64}$', agentCodeExample: 'AL 001' });
    // A template no KPM reads takes the first, and its own example.
    expect(await pattern(PRU_ARCHIVED)).toMatchObject({ agentCodePattern: '^\\d{3,32}$', agentCodeExample: '80777' });
    expect(result.reports.find((r) => r.templateId === PRU_DEFAULT)).toEqual({
      companyId: PRUDENTIAL, templateId: PRU_DEFAULT, name: 'Prudential template', kpms: 2, codes: 3,
      agentCodePattern: '^\\d{3,32}$', effectiveFrom: '2025-01', prudentialDraft: true,
    });
  });

  it('P19.5-T1 AC-3 starts each column at the earliest month a KPM on the template holds, else this month', async () => {
    await up(db(), NOW);
    const from = async (id: string) => ((await sectionOf(id))!.payload as AdvancedAnalyticsConfig).uploadFields
      .map((f) => f.effectiveFrom);
    // 2024-11 holds only an empty cell, so 2025-01 (the library KPM's policies) is the earliest held.
    expect(new Set(await from(PRU_DEFAULT))).toEqual(new Set(['2025-01']));
    expect(new Set(await from(PRU_JAKARTA))).toEqual(new Set(['2026-02']));
    expect(new Set(await from(ALZ_DEFAULT))).toEqual(new Set(['2026-11']));
  });

  it('P19.5-T1 AC-3 offers Prudential’s §3 seed as a draft beside version 1: eight digits, flagged, the mockup’s required flags', async () => {
    await up(db(), NOW);
    const draft = await sectionOf(PRU_DEFAULT, 'draft');
    expect(draft).toMatchObject({ version: 2, revision: 2, status: 'draft' });
    const config = draft!.payload as AdvancedAnalyticsConfig;
    expect(analyticsViolations(config)).toEqual([]);
    expect(config.uploadRules).toMatchObject({ agentCodePattern: '^[0-9]{8}$', agentCodeExample: '70012345', unknownAgent: 'flag' });
    expect(config.uploadFields.filter((f) => f.required).map((f) => f.kode))
      .toEqual(['APE', 'PERSISTENCY', 'RECRUITMENT', 'NEW_ACTIVE_AGENTS', 'POLICY_COUNT']);
    // Only Prudential's default: not its other templates, not another company's, not the library's.
    for (const id of [PRU_JAKARTA, PRU_ARCHIVED, ALZ_DEFAULT, LIB_DEFAULT]) expect(await sectionOf(id, 'draft')).toBeNull();
  });

  it('P19.5-T1 AC-3 is idempotent: a second run writes nothing, and a template already holding the section is left alone', async () => {
    await up(db(), NOW);
    const before = await col('companyTemplates').countDocuments({});
    const again = await up(db(), new Date('2026-12-01T00:00:00Z'));
    expect(again).toEqual({ written: 0, current: 5, drafts: 0, reports: [] });
    expect(await col('companyTemplates').countDocuments({})).toBe(before);
  });
});
