import { DomainException } from '@/common/errors/domain.exception';
import { inSource } from '@/common/i18n/sentence';
import { ANALYTICS } from '@/domain/constants';
import {
  analyticsConfigV1, analyticsViolations, codeCheck, agentCodePattern, newColumns, normaliseAnalyticsDraft,
  platformAnalyticsConfig, prudentialSeedDraft, refuseAnalyticsViolations, uploadChanged,
  type AdvancedAnalyticsConfig, type UploadField,
} from './analytics-config';

const v1 = () => analyticsConfigV1({ effectiveFrom: '2025-01' });
const fieldsOf = (violations: ReturnType<typeof analyticsViolations>) => violations.map((v) => v.field);
const said = (violations: ReturnType<typeof analyticsViolations>, field: string) =>
  inSource(violations.find((v) => v.field === field)!.message);

/** A thrown refusal's code, details and English words. */
function refusal(run: () => unknown): { code: string; details: Record<string, unknown> | undefined; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof DomainException) return { code: err.code, details: err.details, message: inSource(err.sentence) };
    throw err;
  }
  throw new Error('not refused');
}

const fyc = (over: Partial<UploadField> = {}): UploadField => ({
  kode: 'FYC', system: false, label: { id: 'Komisi tahun pertama', en: 'First year commission' }, labelAliases: [],
  unit: 'rp_million', ytd: 'sum', min: 0, max: null, required: true, rows: 'all', effectiveFrom: '2026-12',
  tip: { id: '', en: '' }, ...over,
});

/**
 * **The *Advanced analytics* payload** (P19.5-T1; ADR-0214 §2): its type, refused field by field; the system columns
 * and the locks, `409`; what a rename and a delete keep without asking.
 */
describe('the Advanced analytics payload (ADR-0214 §2)', () => {
  describe('version 1 and the platform default', () => {
    it('P19.5-T1 AC-3 is a payload the section holds: seven columns, six sections, the fixed MAA', () => {
      const config = platformAnalyticsConfig();
      expect(analyticsViolations(config)).toEqual([]);
      expect(config.uploadFields).toHaveLength(7);
      expect(config.uploadRules.agentCodePattern).toBe('^\\d{3,32}$');
      expect(config.derived).toEqual({ maaActiveIfAnyPositive: ['APE', 'POLICY_COUNT'] });
      expect(config.nps.questions.map((q) => q.kode)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
      expect(config.nps).toMatchObject({ promoterMin: 9, passiveMin: 7, cadence: 'quarter' });
      expect(config.qualitative.blocks.map((b) => b.kode)).toEqual(
        ['ABOUT', 'ASPIRATION', 'SALES', 'RECRUIT', 'ACTIVATION', 'UNIT', 'COACHING', 'SUPPORT'],
      );
      expect(config.thresholds).toMatchObject({ ageBandUpper: [29, 45], tenureBands: [3, 7, 10], quantMinPeers: 3 });
    });

    it('P19.5-T1 AC-3 offers Prudential’s seed as eight digits, flagged, with the mockup’s required flags', () => {
      const draft = prudentialSeedDraft(v1());
      expect(analyticsViolations(draft)).toEqual([]);
      expect(draft.uploadRules).toMatchObject({ agentCodePattern: '^[0-9]{8}$', unknownAgent: 'flag' });
      expect(draft.uploadFields.find((f) => f.kode === 'FYP')!.required).toBe(false);
    });
  });

  describe('400: the type, each violation beside its field', () => {
    it('P19.5-T1 AC-6 refuses a kode out of shape or missing, and a missing ID label (“Isi kode.”, “Isi nama.”)', () => {
      const config = v1();
      config.uploadFields.push(fyc({ kode: '' }), fyc({ kode: 'fyc' }), fyc({ kode: 'FYC_YTD' }), fyc({ kode: 'GOOD', label: { id: ' ', en: '' } }));
      const v = analyticsViolations(config);
      expect(said(v, 'uploadFields.7.kode')).toBe('Enter a code.');
      expect(fieldsOf(v)).toEqual(expect.arrayContaining(['uploadFields.8.kode', 'uploadFields.9.kode', 'uploadFields.10.label.id']));
      expect(said(v, 'uploadFields.10.label.id')).toBe('Enter a name.');
    });

    it('P19.5-T1 AC-6 forces a percentage to 0–100 and refuses a minimum above the maximum', () => {
      const config = v1();
      config.uploadFields.push(fyc({ unit: 'percent', max: 105 }), fyc({ kode: 'X', min: 10, max: 5 }));
      const v = analyticsViolations(config);
      expect(said(v, 'uploadFields.7.max')).toBe('A percentage is from 0 to 100.');
      expect(said(v, 'uploadFields.8.min')).toBe('The smallest value must not exceed the largest.');
    });

    it('P19.5-T1 AC-6 refuses a unit, a YTD rule, a rows value or a start month it does not know', () => {
      const config = v1();
      config.uploadFields.push(fyc({ unit: 'usd' as never, ytd: 'avg' as never, rows: 'some' as never, effectiveFrom: '2026-13' }));
      expect(fieldsOf(analyticsViolations(config))).toEqual(
        ['uploadFields.7.unit', 'uploadFields.7.ytd', 'uploadFields.7.rows', 'uploadFields.7.effectiveFrom'],
      );
    });

    it('P19.5-T1 AC-4 holds the six sections, each once', () => {
      const config = v1();
      config.sections = config.sections.slice(1);
      expect(fieldsOf(analyticsViolations(config))).toEqual(['sections']);
      const twice = v1();
      twice.sections[1] = { kode: 'DEMOGRAPHICS', enabled: false };
      expect(fieldsOf(analyticsViolations(twice))).toEqual(['sections']);
    });

    it('P19.5-T1 AC-10 refuses any MAA but the fixed APE and POLICY_COUNT (decision 1(b))', () => {
      const config = v1();
      config.derived = { maaActiveIfAnyPositive: ['APE'] };
      expect(fieldsOf(analyticsViolations(config))).toEqual(['derived.maaActiveIfAnyPositive']);
    });

    it('P19.5-T1 AC-11 refuses a pattern the linear engine refuses, an example it does not match, and the bounds', () => {
      const config = v1();
      config.uploadRules = {
        ...config.uploadRules, agentCodePattern: '^(a)\\1$', completePct: 49, ytdTolerancePct: 11, historyMonthsBeforeJoin: 6,
      };
      const v = analyticsViolations(config);
      expect(fieldsOf(v)).toEqual([
        'uploadRules.agentCodePattern', 'uploadRules.historyMonthsBeforeJoin', 'uploadRules.completePct',
        'uploadRules.ytdTolerancePct',
      ]);
      const unmatched = v1();
      unmatched.uploadRules.agentCodeExample = 'ABC';
      expect(fieldsOf(analyticsViolations(unmatched))).toEqual(['uploadRules.agentCodeExample']);
    });

    it('P19.5-T1 AC-13 refuses a passive cut-off not below the promoter one (“Batas pasif harus lebih kecil dari promotor.”)', () => {
      const config = v1();
      config.nps.passiveMin = 9;
      const v = analyticsViolations(config);
      expect(fieldsOf(v)).toEqual(['nps.passiveMin']);
      expect(v[0].message.id).toBe('Batas pasif harus lebih kecil dari promotor.');
    });

    it('P19.5-T1 AC-13 keeps at least one score question, each kode once', () => {
      const none = v1();
      none.nps.questions = [];
      expect(fieldsOf(analyticsViolations(none))).toEqual(['nps.questions']);
      const twice = v1();
      twice.nps.questions[1].kode = 'P1';
      expect(fieldsOf(analyticsViolations(twice))).toEqual(['nps.questions.1.kode']);
    });

    it('P19.5-T1 AC-14 refuses “Perlu perhatian” not below “Masalah besar”, bands that do not rise, and the fixed peers', () => {
      const config = v1();
      config.thresholds = { ...config.thresholds, qualWatchPct: 60, ageBandUpper: [45, 29], quantMinPeers: 2 };
      const v = analyticsViolations(config);
      expect(fieldsOf(v)).toEqual(['thresholds.ageBandUpper', 'thresholds.quantMinPeers', 'thresholds.qualWatchPct']);
      expect(v.find((x) => x.field === 'thresholds.qualWatchPct')!.message.id)
        .toBe('"Perlu perhatian" harus lebih kecil dari "Masalah besar".');
    });

    it('P19.5-T1 refuses a key the section does not have, and a payload that is no object', () => {
      expect(fieldsOf(analyticsViolations({ ...v1(), extra: 1 }))).toEqual(['extra']);
      expect(fieldsOf(analyticsViolations(null))).toEqual(['payload']);
    });

    it('P19.5-T1 AC-6 holds at most ANALYTICS.UPLOAD_FIELDS_MAX columns (“Template berisi paling banyak 40 kolom”)', () => {
      const full = v1();
      for (let i = full.uploadFields.length; i < ANALYTICS.UPLOAD_FIELDS_MAX; i += 1) full.uploadFields.push(fyc({ kode: `F${i}` }));
      expect(analyticsViolations(full)).toEqual([]);
      full.uploadFields.push(fyc({ kode: 'ONE_TOO_MANY' }));
      const v = analyticsViolations(full);
      expect(fieldsOf(v)).toEqual(['uploadFields']);
      expect(said(v, 'uploadFields')).toBe('A template holds at most 40 Data upload columns.');
    });

    it('P19.5-T1 refuses 400 VALIDATION_FAILED with every violation in details', () => {
      const config = v1();
      config.nps.passiveMin = 9;
      const r = refusal(() => refuseAnalyticsViolations(analyticsViolations(config)));
      expect(r.code).toBe('VALIDATION_FAILED');
      expect((r.details!.violations as { field: string }[]).map((v) => v.field)).toEqual(['nps.passiveMin']);
      expect(refuseAnalyticsViolations([])).toBeUndefined();
    });
  });

  /**
   * **A part in a shape the section cannot hold** (P19.5-T1 AC-6; ADR-0214 §2): what a hand-made request, or an editor out
   * of step with the server, sends. Each is refused beside its own field, and every one in the payload is heard about
   * together — never a `500`, and never only the first.
   */
  describe('400: a part in the wrong shape, beside its field', () => {
    const broken = (mutate: (c: AdvancedAnalyticsConfig) => void) => {
      const config = v1();
      mutate(config);
      return analyticsViolations(config);
    };

    it.each<[string, (c: AdvancedAnalyticsConfig) => void, string[]]>([
      ['the sections not a list', (c) => { c.sections = 'all' as never; }, ['sections']],
      ['a section no object, another’s switch not yes-or-no', (c) => {
        c.sections[0] = 'DEMOGRAPHICS' as never;
        c.sections[1].enabled = 'yes' as never;
      }, ['sections', 'sections.1.enabled']],
      ['the archive not a list', (c) => { c.archivedFields = null as never; }, ['archivedFields']],
      ['a column no object', (c) => { c.uploadFields.push('FYC' as never); }, ['uploadFields.7']],
      ['a column with a key it does not have', (c) => { c.uploadFields.push(fyc({ colour: 'red' } as never)); }, ['uploadFields.7.colour']],
      ['a column’s flag, label, aliases and minimum each the wrong type', (c) => {
        c.uploadFields.push(fyc({ system: 'no' as never, label: 'FYC' as never, labelAliases: 'FYC' as never, min: '0' as never }));
      }, ['uploadFields.7.system', 'uploadFields.7.label', 'uploadFields.7.labelAliases', 'uploadFields.7.min']],
      ['MAA’s inputs missing altogether', (c) => { c.derived = null as never; }, ['derived.maaActiveIfAnyPositive']],
      ['the upload rules no object', (c) => { c.uploadRules = [] as never; }, ['uploadRules']],
      ['an agent-code pattern that is no text', (c) => { c.uploadRules.agentCodePattern = 42 as never; }, ['uploadRules.agentCodePattern']],
      ['no example of an agent code', (c) => { c.uploadRules.agentCodeExample = ''; }, ['uploadRules.agentCodeExample']],
      ['the NPS survey no object', (c) => { c.nps = 'quarterly' as never; }, ['nps']],
      ['the NPS questions not a list', (c) => { c.nps.questions = {} as never; }, ['nps.questions']],
      ['NPS defaults, a question, a question’s kode and the open question each wrong', (c) => {
        c.nps.defaults = null as never;
        c.nps.questions[0] = 'P1' as never;
        c.nps.questions[1].kode = 'OPEN';
        c.nps.openQuestion = { ...c.nps.openQuestion, kode: 'P6' as never };
      }, ['nps.defaults', 'nps.questions.0', 'nps.questions.1.kode', 'nps.openQuestion']],
      ['the qualitative survey no object', (c) => { c.qualitative = null as never; }, ['qualitative']],
      ['the qualitative months moved and its defaults a list', (c) => {
        c.qualitative.months = [6];
        c.qualitative.defaults = [] as never;
      }, ['qualitative.months', 'qualitative.defaults']],
      ['the qualitative blocks not a list', (c) => { c.qualitative.blocks = 'ALL' as never; }, ['qualitative.blocks']],
      ['a block no object, a block’s kode out of shape, a block’s questions not a list', (c) => {
        c.qualitative.blocks[0] = 'ABOUT' as never;
        c.qualitative.blocks[1].kode = 'aspiration';
        c.qualitative.blocks[2].questions = null as never;
      }, ['qualitative.blocks.0', 'qualitative.blocks.1.kode', 'qualitative.blocks.2.questions']],
      ['a question no object, a question’s kode out of shape, and one kode twice across blocks', (c) => {
        c.qualitative.blocks[0].questions[0] = 'Q1' as never;
        c.qualitative.blocks[0].questions[1].kode = 'q2';
        c.qualitative.blocks[2].questions[0].kode = 'Q4';
      }, ['qualitative.blocks.0.questions.0', 'qualitative.blocks.0.questions.1.kode', 'qualitative.blocks.2.questions.0.kode']],
      ['P19.5-T4 an item no object, an item’s kode twice, an item’s exclusive flag, and items not a list', (c) => {
        const q4 = c.qualitative.blocks[1].questions[0];
        q4.items![0] = 'TOP' as never;
        q4.items![2].kode = q4.items![1].kode;
        q4.items![3].exclusive = 'yes' as never;
        c.qualitative.blocks[2].questions[0].items = 'FREQUENCY' as never;
      }, [
        'qualitative.blocks.1.questions.0.items.0', 'qualitative.blocks.1.questions.0.items.2.kode',
        'qualitative.blocks.1.questions.0.items.3.exclusive', 'qualitative.blocks.2.questions.0.items',
      ]],
      ['the thresholds no object', (c) => { c.thresholds = 'default' as never; }, ['thresholds']],
      ['ADR-0215 §8 two tenure bands for three, leader support crossed, power-user days past the window, no head defaults', (c) => {
        c.thresholds = {
          ...c.thresholds, tenureBands: [3, 7] as never, supportPromMin: 8, supportPasMin: 8, powerUserWindow: 7, powerUserDays: 8,
          subgroupHeadDefaults: null as never,
        };
      }, ['thresholds.tenureBands', 'thresholds.supportPasMin', 'thresholds.powerUserDays', 'thresholds.subgroupHeadDefaults']],
    ])('P19.5-T1 AC-6 refuses %s', (_what, mutate, fields) => {
      expect(fieldsOf(broken(mutate))).toEqual(fields);
    });

    it('P19.5-T1 AC-6 says what is wrong with each, in words the editor shows beside the field', () => {
      const v = broken((c) => {
        c.sections = 'all' as never;
        c.uploadFields.push(fyc({ system: 'no' as never, label: { id: 5, en: 'x'.repeat(ANALYTICS.LABEL_MAX_LENGTH + 1) } as never, min: '0' as never }));
        c.nps.defaults = null as never;
        c.uploadRules.agentCodePattern = 42 as never;
        c.qualitative.blocks[2].questions[0].kode = 'Q4';
        c.thresholds = { ...c.thresholds, supportPromMin: 8, supportPasMin: 8, powerUserWindow: 7, powerUserDays: 8 };
      });
      expect(said(v, 'sections')).toBe('Must be a list.');
      expect(said(v, 'uploadFields.7.system')).toBe('Must be true or false.');
      expect(said(v, 'uploadFields.7.label.id')).toBe('Enter a name.');
      expect(said(v, 'uploadFields.7.label.en')).toBe('At most 60 characters.');
      expect(said(v, 'uploadFields.7.min')).toBe('Must be a number, or empty.');
      expect(said(v, 'nps.defaults')).toBe('Must be an object.');
      expect(said(v, 'uploadRules.agentCodePattern')).toBe('The agent code format is not a pattern that can be read.');
      expect(said(v, 'qualitative.blocks.2.questions.0.kode')).toBe('Q4: this question code is already used.');
      expect(said(v, 'thresholds.supportPasMin')).toBe('Leader support: "enough" must be below "satisfied".');
      expect(said(v, 'thresholds.powerUserDays')).toBe('A power user\'s days fit inside the window.');
    });

    it('P19.5-T1 AC-6 lets a column leave its English label out: the ID label stands in for it', () => {
      expect(broken((c) => { c.uploadFields.push(fyc({ label: { id: 'Komisi' } as never })); })).toEqual([]);
    });
  });

  describe('409: the system columns, the locks, a kode taken', () => {
    const none = new Set<string>();

    it('P19.5-T1 AC-5 refuses a draft without a system column (ANALYTICS_SYSTEM_COLUMN), naming it', () => {
      const draft = v1();
      draft.uploadFields = draft.uploadFields.filter((f) => f.kode !== 'APE');
      const r = refusal(() => normaliseAnalyticsDraft(draft, v1(), none));
      expect(r).toMatchObject({ code: 'ANALYTICS_SYSTEM_COLUMN', details: { kode: 'APE', field: 'uploadFields' } });
      expect(r.message).toBe('APE is a system column: it can be renamed, not deleted.');
    });

    it('P19.5-T1 AC-5 refuses a system column’s unit or YTD changed, or one marked otherwise, and another kode marked system', () => {
      const unit = v1();
      unit.uploadFields[0] = { ...unit.uploadFields[0], unit: 'count' };
      expect(refusal(() => normaliseAnalyticsDraft(unit, v1(), none))).toMatchObject({
        code: 'ANALYTICS_SYSTEM_COLUMN', details: { field: 'uploadFields.0.unit', kode: 'APE' },
      });
      const ytd = v1();
      ytd.uploadFields[2] = { ...ytd.uploadFields[2], ytd: 'upload' };
      expect(refusal(() => normaliseAnalyticsDraft(ytd, v1(), none)).details).toEqual({ field: 'uploadFields.2.ytd', kode: 'RECRUITMENT' });
      const unmarked = v1();
      unmarked.uploadFields[5] = { ...unmarked.uploadFields[5], system: false };
      expect(refusal(() => normaliseAnalyticsDraft(unmarked, v1(), none)).details).toEqual({ field: 'uploadFields.5.system', kode: 'POLICY_COUNT' });
      const marked = v1();
      marked.uploadFields.push(fyc({ system: true }));
      expect(refusal(() => normaliseAnalyticsDraft(marked, v1(), none)).details).toEqual({ field: 'uploadFields', kode: 'FYC' });
    });

    it('P19.5-T1 AC-5 lets a system column be renamed: “APE bersih”, its old label kept as an alias', () => {
      const draft = v1();
      draft.uploadFields[0] = { ...draft.uploadFields[0], label: { id: 'APE bersih', en: 'Net-of-nothing APE' } };
      const saved = normaliseAnalyticsDraft(draft, v1(), none);
      expect(saved.uploadFields[0].label).toEqual({ id: 'APE bersih', en: 'Net-of-nothing APE' });
      expect(saved.uploadFields[0].labelAliases).toContain('APE');
    });

    it('P19.5-T1 AC-6 refuses two current columns with one kode (ANALYTICS_KODE_TAKEN, “Kode ini sudah dipakai.”)', () => {
      const draft = v1();
      draft.uploadFields.push(fyc(), fyc());
      const r = refusal(() => normaliseAnalyticsDraft(draft, v1(), none));
      expect(r).toMatchObject({ code: 'ANALYTICS_KODE_TAKEN', details: { field: 'uploadFields.8.kode', kode: 'FYC' } });
    });

    it('P19.5-T1 AC-7 locks the unit of a kode a KPM holds data for (ANALYTICS_UNIT_LOCKED), and leaves one without data free', () => {
      const draft = v1();
      draft.uploadFields[1] = { ...draft.uploadFields[1], unit: 'count', max: null };
      const r = refusal(() => normaliseAnalyticsDraft(draft, v1(), new Set(['PERSISTENCY'])));
      expect(r).toMatchObject({ code: 'ANALYTICS_UNIT_LOCKED', details: { field: 'uploadFields.1.unit', kode: 'PERSISTENCY' } });
      expect(r.message).toContain('Make a new column for another unit');
      expect(normaliseAnalyticsDraft(draft, v1(), none).uploadFields[1].unit).toBe('count');
    });

    it('P19.5-T1 AC-6 locks the start month of a kode with data (ANALYTICS_EFFECTIVE_FROM_LOCKED)', () => {
      const draft = v1();
      draft.uploadFields[4] = { ...draft.uploadFields[4], effectiveFrom: '2026-01' };
      expect(refusal(() => normaliseAnalyticsDraft(draft, v1(), new Set(['FYP'])))).toMatchObject({
        code: 'ANALYTICS_EFFECTIVE_FROM_LOCKED', details: { field: 'uploadFields.4.effectiveFrom', kode: 'FYP' },
      });
    });
  });

  describe('what a draft keeps without asking', () => {
    const none = new Set<string>();

    it('P19.5-T1 AC-9 keeps a rename’s previous ID and EN labels as aliases, case-folded, never trusting the editor’s', () => {
      const draft = v1();
      draft.uploadFields[2] = {
        ...draft.uploadFields[2], label: { id: 'Rekrut baru', en: 'New recruits' }, labelAliases: ['made up'],
      };
      const saved = normaliseAnalyticsDraft(draft, v1(), none);
      expect(saved.uploadFields[2].labelAliases).toEqual(
        ['Recruitment', 'Recruitment — This Month', 'Recruitment — YTD', 'Rekrutmen'],
      );
      // A draft that renames nothing changes no alias: saving version 1 as it is keeps it as it is.
      expect(normaliseAnalyticsDraft(v1(), v1(), none).uploadFields).toEqual(v1().uploadFields);
      // A replaced label the column still carries is not added again.
      const half = v1();
      half.uploadFields[2] = { ...half.uploadFields[2], label: { id: 'Rekrut baru', en: 'Recruitment' } };
      expect(normaliseAnalyticsDraft(half, v1(), none).uploadFields[2].labelAliases)
        .toEqual(['Recruitment', 'Recruitment — This Month', 'Recruitment — YTD', 'Rekrutmen']);
    });

    it('P19.5-T1 AC-8 archives a custom column dropped from the list, and never loses a kode', () => {
      const draft = v1();
      draft.uploadFields = draft.uploadFields.filter((f) => f.kode !== 'FYP');
      const saved = normaliseAnalyticsDraft(draft, v1(), new Set(['FYP']));
      expect(saved.uploadFields.map((f) => f.kode)).not.toContain('FYP');
      expect(saved.archivedFields.map((f) => f.kode)).toEqual(['FYP']);
    });

    it('P19.5-T1 AC-6 saves a new column’s labels trimmed, an English label left out as empty, a percentage’s empty minimum as 0', () => {
      const draft = v1();
      draft.uploadFields.push(
        fyc({ label: { id: '  Komisi tahun pertama ' } as never }),
        fyc({ kode: 'RETENTION', unit: 'percent', min: null, max: 100 }),
      );
      const saved = normaliseAnalyticsDraft(draft, v1(), none);
      expect(saved.uploadFields[7]).toMatchObject({ kode: 'FYC', label: { id: 'Komisi tahun pertama', en: '' }, labelAliases: [] });
      expect(saved.uploadFields[8]).toMatchObject({ kode: 'RETENTION', min: 0, max: 100 });
      // A column of another unit keeps an empty minimum empty.
      const count = v1();
      count.uploadFields.push(fyc({ min: null }));
      expect(normaliseAnalyticsDraft(count, v1(), none).uploadFields[7].min).toBeNull();
    });

    it('P19.5-T1 AC-8 keeps an archived column the published version never had, as the draft holds it', () => {
      const draft = v1();
      draft.archivedFields = [fyc({ kode: 'OLD_BONUS', labelAliases: ['Bonus lama'] })];
      const saved = normaliseAnalyticsDraft(draft, v1(), none);
      expect(saved.archivedFields).toEqual([fyc({ kode: 'OLD_BONUS', labelAliases: ['Bonus lama'] })]);
    });

    it('P19.5-T1 AC-8 restores an archived column when its kode is added again (AT-13), out of the archive', () => {
      const published = v1();
      const fyp = published.uploadFields.find((f) => f.kode === 'FYP')!;
      published.uploadFields = published.uploadFields.filter((f) => f.kode !== 'FYP');
      published.archivedFields = [fyp];
      const draft = structuredClone(published);
      draft.uploadFields.push({ ...fyp, label: { id: 'FYP lagi', en: '' } });
      const saved = normaliseAnalyticsDraft(draft, published, new Set(['FYP']));
      expect(saved.uploadFields.map((f) => f.kode)).toContain('FYP');
      expect(saved.archivedFields).toEqual([]);
      expect(saved.uploadFields.find((f) => f.kode === 'FYP')!.labelAliases).toContain('FYP');
      // Its unit stays locked while it holds data.
      draft.uploadFields[draft.uploadFields.length - 1] = { ...fyp, unit: 'count' };
      expect(refusal(() => normaliseAnalyticsDraft(draft, published, new Set(['FYP']))).code).toBe('ANALYTICS_UNIT_LOCKED');
    });
  });

  describe('a publish', () => {
    it('P19.5-T1 AC-11 counts the registered codes a pattern refuses, naming up to five', () => {
      const compiled = agentCodePattern('^[0-9]{8}$');
      if (!('pattern' in compiled)) throw new Error('refused');
      const codes = ['70012345', '80777', '12', 'ABC', '1', '2', '3', '70012388'];
      expect(codeCheck(compiled.pattern, codes)).toEqual({ mismatched: 6, total: 8, examples: ['80777', '12', 'ABC', '1', '2'] });
      expect('refusal' in agentCodePattern('[0-9]+')).toBe(true);
    });

    it('P19.5-T1 AC-15 names the new columns, each with its start month', () => {
      const next = v1();
      next.uploadFields.push(fyc());
      expect(newColumns(v1(), next).map((f) => [f.kode, f.effectiveFrom])).toEqual([['FYC', '2026-12']]);
      expect(newColumns(null, v1())).toHaveLength(7);
    });

    it('P19.5-T1 AC-17 tells KPMs of a change to the columns, the archive or the rules — never of sections or thresholds alone', () => {
      const sections = v1();
      sections.sections[0].enabled = false;
      sections.thresholds.qualBigPct = 70;
      sections.nps.promoterMin = 8;
      expect(uploadChanged(v1(), sections)).toBe(false);
      const rules: AdvancedAnalyticsConfig = v1();
      rules.uploadRules.completePct = 80;
      expect(uploadChanged(v1(), rules)).toBe(true);
      const columns = v1();
      columns.uploadFields.push(fyc());
      expect(uploadChanged(v1(), columns)).toBe(true);
      expect(uploadChanged(null, v1())).toBe(true);
    });
  });
});
