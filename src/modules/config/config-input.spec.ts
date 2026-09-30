import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateActivityCategoryDto, CreateActivityTypeDto, UpdateActivityCategoryDto, UpdateActivityTypeDto,
} from './activity.dto';
import {
  checkCategoryCreate, checkCategoryUpdate, checkLeadStatusCreate, checkLeadStatusLabel,
  checkNoFields, checkRatioCreate, checkRatioUpdate, checkTypeCreate, checkTypeUpdate,
} from './config-input';
import { CreateLeadStatusDto, RenameLeadStatusDto } from './lead-status.dto';
import { CreateRatioDto, UpdateRatioDto } from './ratio.dto';

const long = (length: number) => 'x'.repeat(length);
const codes = (count: number) => Array.from({ length: count }, (_, i) => `TYPE_${i}`);

/** The refusal a checker raises, or `null` when it accepts. */
function refusal(check: () => unknown): { code: string; message: string; violations: string[] } | null {
  try {
    check();
    return null;
  } catch (err) {
    const e = err as { code: string; message: string; details: { violations: string[] } };
    return { code: e.code, message: e.message, violations: e.details.violations };
  }
}

describe('configuration field rules (ADR-0030)', () => {
  describe('what a checker gives back', () => {
    it('trims text, upper-cases codes, and reads a blank description as none', () => {
      expect(checkCategoryCreate({ code: ' referrals ', label: '  Referrals  ', description: '   ' }))
        .toEqual({
          code: 'REFERRALS', label: 'Referrals', description: null, appliesToOrgLevelCodes: [],
          // No tile named is a tile of its own (ADR-0064).
          summaryGroupCode: null, summaryGroupLabel: null,
        });
      expect(checkTypeCreate({ code: 'sell_x', categoryCode: 'selling', label: 'X', description: ' a ' }))
        .toEqual({ code: 'SELL_X', categoryCode: 'SELLING', label: 'X', description: 'a' });
    });

    it('drops absent fields, so an empty update is still an empty change', () => {
      // A service's "nothing to change" looks for keys; carrying `label: undefined` would
      // turn an empty change into a write of nothing.
      expect(checkCategoryUpdate({})).toEqual({});
      expect(checkTypeUpdate({ label: undefined })).toEqual({});
      expect(checkRatioUpdate({ benchmark: 0.2 })).toEqual({ benchmark: 0.2 });
    });

    it('keeps an explicit null description, which clears it', () => {
      expect(checkTypeUpdate({ description: null })).toEqual({ description: null });
    });

    it('reads a section’s summary tile as a pair: set together, cleared together, or left alone (ADR-0064)', () => {
      expect(checkCategoryCreate({ code: 'ref', label: 'Ref' }))
        .toMatchObject({ summaryGroupCode: null, summaryGroupLabel: null });
      expect(checkCategoryCreate({
        code: 'ref', label: 'Ref', summaryGroupCode: ' development ', summaryGroupLabel: ' Development ',
      })).toMatchObject({ summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' });
      expect(checkCategoryUpdate({ summaryGroupCode: null, summaryGroupLabel: null }))
        .toEqual({ summaryGroupCode: null, summaryGroupLabel: null });
      // Absent is untouched, as every update field here is.
      expect(checkCategoryUpdate({ label: 'Penjualan' })).toEqual({ label: 'Penjualan' });
    });

    it('refuses half a summary tile, and a malformed one', () => {
      const pair = 'summaryGroupCode and summaryGroupLabel are set together, or cleared together with null.';
      for (const body of [
        { summaryGroupCode: 'SALES' },
        { summaryGroupLabel: 'Sales' },
        { summaryGroupCode: null, summaryGroupLabel: 'Sales' },
        { summaryGroupCode: 'SALES', summaryGroupLabel: null },
        { summaryGroupCode: null },
      ]) {
        expect(refusal(() => checkCategoryUpdate(body))?.violations).toEqual([pair]);
      }
      expect(refusal(() => checkCategoryUpdate({ summaryGroupCode: 'no spaces', summaryGroupLabel: 'x' }))?.violations)
        .toEqual([expect.stringContaining('summaryGroupCode: A code is')]);
      expect(refusal(() => checkCategoryUpdate({ summaryGroupCode: 'SALES', summaryGroupLabel: 7 }))?.violations)
        .toEqual(['summaryGroupLabel must be text.']);
      expect(refusal(() => checkCategoryCreate({ code: 'REF', label: 'x', summaryGroupCode: 'SALES' }))?.violations)
        .toEqual([pair]);
    });

    it('accepts a whole ratio and a whole lead status', () => {
      expect(checkRatioCreate({
        code: 'referral_rate', label: 'Referral rate', numerator: ['A_B_C'], denominator: ['D_E_F'],
        benchmark: 0.15, comparison: 'gte', displayUnit: 'percent', appliesToOrgLevelCodes: ['AB'],
      })).toMatchObject({ code: 'REFERRAL_RATE', displayUnit: 'percent', appliesToOrgLevelCodes: ['AB'] });
      expect(checkLeadStatusCreate({ pipeline: 'sales', code: 'awaiting_x', label: ' Waiting ' }))
        .toEqual({ pipeline: 'sales', code: 'AWAITING_X', label: 'Waiting' });
      expect(checkLeadStatusLabel(' Menunggu ')).toBe('Menunggu');
    });
  });

  describe('what a checker refuses', () => {
    it('names every field at fault at once, the way the pipe does', () => {
      const refused = refusal(() => checkCategoryCreate({ code: '1x', label: '', description: 5, colour: 'red' }));
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(refused!.violations).toEqual(expect.arrayContaining([
        'property colour should not exist',
        expect.stringContaining('code: A code is 3–40 characters'),
        'label must be 1–80 characters.',
        'description must be text.',
      ]));
      expect(refused!.message).toBe(refused!.violations.join('; '));
    });

    it('refuses a body that is not an object of fields', () => {
      for (const body of [null, [], 'benchmark', 42]) {
        expect(refusal(() => checkRatioUpdate(body))?.violations)
          .toContain('The change must be an object of fields.');
      }
    });

    it('refuses a value of the wrong type, rather than failing on it once it is being written', () => {
      expect(refusal(() => checkTypeUpdate({ label: 42 }))?.violations).toEqual(['label must be text.']);
      expect(refusal(() => checkTypeUpdate({ description: 42 }))?.violations)
        .toEqual(['description must be text.']);
      expect(refusal(() => checkRatioUpdate({ benchmark: '0.15' }))?.violations)
        .toEqual(['benchmark must be a number from 0 to 1000.']);
      expect(refusal(() => checkRatioUpdate({ numerator: 'SELL_SUBMISSION' }))?.violations)
        .toEqual(['numerator must be a list of codes.']);
      expect(refusal(() => checkRatioUpdate({ numerator: ['SELL_SUBMISSION', 7] }))?.violations)
        .toEqual(['numerator must be a list of codes.']);
      expect(refusal(() => checkRatioUpdate({ comparison: 'lte' }))?.violations)
        .toEqual(['comparison must be one of gte, band.']);
      expect(refusal(() => checkRatioUpdate({ displayUnit: 7 }))?.violations)
        .toEqual(['displayUnit must be one of percent, decimal, points.']);
      expect(refusal(() => checkTypeUpdate({ categoryCode: 7 }))?.violations)
        .toEqual([expect.stringContaining('categoryCode: A code is')]);
    });

    it('requires what a create cannot do without', () => {
      expect(refusal(() => checkRatioCreate({}))?.violations).toEqual([
        'code is required.', 'label is required.', 'numerator is required.',
        'denominator is required.', 'benchmark is required.', 'comparison is required.',
      ]);
      expect(refusal(() => checkLeadStatusCreate({}))?.violations)
        .toEqual(['pipeline is required.', 'code is required.', 'label is required.']);
      expect(refusal(() => checkLeadStatusLabel(undefined))?.violations).toEqual(['label is required.']);
    });

    it.each([
      ['a category label', () => checkCategoryCreate({ code: 'ABC', label: long(80) }),
        () => checkCategoryCreate({ code: 'ABC', label: long(81) }), 'label must be 1–80 characters.'],
      ['a type label', () => checkTypeUpdate({ label: long(200) }),
        () => checkTypeUpdate({ label: long(201) }), 'label must be 1–200 characters.'],
      ['a ratio label', () => checkRatioUpdate({ label: long(80) }),
        () => checkRatioUpdate({ label: long(81) }), 'label must be 1–80 characters.'],
      ['a lead status label', () => checkLeadStatusLabel(long(80)),
        () => checkLeadStatusLabel(long(81)), 'label must be 1–80 characters.'],
      ['a description', () => checkCategoryUpdate({ description: long(200) }),
        () => checkCategoryUpdate({ description: long(201) }), 'description must be at most 200 characters.'],
      ['a list of rungs', () => checkCategoryUpdate({ appliesToOrgLevelCodes: codes(20) }),
        () => checkCategoryUpdate({ appliesToOrgLevelCodes: codes(21) }),
        'appliesToOrgLevelCodes must name 0–20 codes.'],
      ['a formula side', () => checkRatioUpdate({ numerator: codes(50) }),
        () => checkRatioUpdate({ numerator: codes(51) }),
        'A ratio counts at most 50 activity types in its numerator.'],
      ['the lowest benchmark', () => checkRatioUpdate({ benchmark: 0 }),
        () => checkRatioUpdate({ benchmark: -0.001 }), 'benchmark must be a number from 0 to 1000.'],
      ['the highest benchmark', () => checkRatioUpdate({ benchmark: 1000 }),
        () => checkRatioUpdate({ benchmark: 1000.001 }), 'benchmark must be a number from 0 to 1000.'],
    ])('holds %s at its edge', (_name, atTheEdge, overIt, violation) => {
      expect(refusal(atTheEdge)).toBeNull();
      expect(refusal(overIt)?.violations).toEqual([violation]);
    });

    it('refuses a benchmark that is not a finite number', () => {
      for (const benchmark of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(refusal(() => checkRatioUpdate({ benchmark }))?.violations)
          .toEqual(['benchmark must be a number from 0 to 1000.']);
      }
    });

    it('says what a ratio needs when a side is empty, not how long a list may be', () => {
      // An empty side is a division by zero dressed up as configuration.
      expect(refusal(() => checkRatioUpdate({ denominator: [] }))?.violations)
        .toEqual(['A ratio needs at least one activity type in its denominator.']);
    });

    it('lets an archive or a restore carry nothing, and nothing else', () => {
      expect(refusal(() => checkNoFields(undefined))).toBeNull();
      expect(refusal(() => checkNoFields({}))).toBeNull();
      expect(refusal(() => checkNoFields({ label: 'x' }))?.violations)
        .toEqual(['property label should not exist']);
    });
  });

  describe('the DTOs and the checkers agree', () => {
    /*
     * The rule is written twice — as decorators, for the pipe and the OpenAPI document, and as
     * a checker, for every path. The numbers are shared, so they cannot drift; the logic can,
     * so the same boundary inputs go through both and must get the same verdict.
     *
     * Deliberately absent: `null` on an optional field. The pipe's `@IsOptional()` lets a null
     * label through to the service, which then called `.trim()` on it; the checker refuses it.
     * That is the checker being right, not the two disagreeing about a rule.
     */
    const cases: Array<[string, new () => object, (body: Record<string, unknown>) => unknown, Record<string, unknown>]> = [
      ['category create, whole', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: 'Referrals' }],
      ['category create, label too long', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: long(81) }],
      ['category create, blank label', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: '   ' }],
      ['category create, not a code', CreateActivityCategoryDto, checkCategoryCreate, { code: 'no spaces', label: 'x' }],
      ['category create, unknown field', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: 'x', colour: 'red' }],
      ['category create, too many rungs', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: 'x', appliesToOrgLevelCodes: codes(21) }],
      ['category update, label only', UpdateActivityCategoryDto, checkCategoryUpdate, { label: 'Penjualan' }],
      ['category update, description too long', UpdateActivityCategoryDto, checkCategoryUpdate, { description: long(201) }],
      /*
       * The summary tile (ADR-0064), field by field. **Half a pair is deliberately absent**: it is a
       * rule across two fields, which a per-field decorator cannot state, and the route reaches the
       * checker through its service — so the pipe passing it is the pipe not knowing, not the two
       * disagreeing.
       */
      ['category update, a whole tile', UpdateActivityCategoryDto, checkCategoryUpdate, { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' }],
      ['category update, a tile cleared', UpdateActivityCategoryDto, checkCategoryUpdate, { summaryGroupCode: null, summaryGroupLabel: null }],
      ['category update, tile code not a code', UpdateActivityCategoryDto, checkCategoryUpdate, { summaryGroupCode: 'no spaces', summaryGroupLabel: 'x' }],
      ['category update, tile label too long', UpdateActivityCategoryDto, checkCategoryUpdate, { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: long(81) }],
      ['category update, tile label blank', UpdateActivityCategoryDto, checkCategoryUpdate, { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: '  ' }],
      ['category create, in a tile', CreateActivityCategoryDto, checkCategoryCreate, { code: 'REFERRALS', label: 'x', summaryGroupCode: 'SELLING', summaryGroupLabel: 'Selling' }],
      ['type create, whole', CreateActivityTypeDto, checkTypeCreate, { code: 'SELL_X', categoryCode: 'SELLING', label: 'x' }],
      ['type create, label too long', CreateActivityTypeDto, checkTypeCreate, { code: 'SELL_X', categoryCode: 'SELLING', label: long(201) }],
      ['type create, section not a code', CreateActivityTypeDto, checkTypeCreate, { code: 'SELL_X', categoryCode: 'sell ing', label: 'x' }],
      ['type update, label a number', UpdateActivityTypeDto, checkTypeUpdate, { label: 42 }],
      ['ratio create, whole', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: ['A_B_C'], denominator: ['D_E_F'], benchmark: 0.15, comparison: 'gte' }],
      ['ratio create, benchmark over', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: ['A_B_C'], denominator: ['D_E_F'], benchmark: 1000.5, comparison: 'gte' }],
      ['ratio create, benchmark as text', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: ['A_B_C'], denominator: ['D_E_F'], benchmark: '0.15', comparison: 'gte' }],
      ['ratio create, empty numerator', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: [], denominator: ['D_E_F'], benchmark: 1, comparison: 'gte' }],
      ['ratio create, 51 terms', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: codes(51), denominator: ['D_E_F'], benchmark: 1, comparison: 'gte' }],
      ['ratio create, unknown rule', CreateRatioDto, checkRatioCreate, { code: 'REFERRAL_RATE', label: 'x', numerator: ['A_B_C'], denominator: ['D_E_F'], benchmark: 1, comparison: 'lte' }],
      ['ratio update, benchmark only', UpdateRatioDto, checkRatioUpdate, { benchmark: 30 }],
      ['ratio update, unknown unit', UpdateRatioDto, checkRatioUpdate, { displayUnit: 'percent1' }],
      ['ratio update, empty label', UpdateRatioDto, checkRatioUpdate, { label: '' }],
      ['ratio update, code is not updatable', UpdateRatioDto, checkRatioUpdate, { code: 'NEW_CODE' }],
      ['lead status create, whole', CreateLeadStatusDto, checkLeadStatusCreate, { pipeline: 'sales', code: 'AWAITING_X', label: 'x' }],
      ['lead status create, unknown pipeline', CreateLeadStatusDto, checkLeadStatusCreate, { pipeline: 'services', code: 'AWAITING_X', label: 'x' }],
      ['lead status rename, whole', RenameLeadStatusDto, (b) => checkLeadStatusLabel(b.label), { label: 'Menunggu' }],
      ['lead status rename, too long', RenameLeadStatusDto, (b) => checkLeadStatusLabel(b.label), { label: long(81) }],
    ];

    it.each(cases)('%s', async (_name, Dto, check, body) => {
      const errors = await validate(plainToInstance(Dto, body), {
        whitelist: true, forbidNonWhitelisted: true,
      });
      const pipeAccepts = errors.length === 0;
      const checkerAccepts = refusal(() => check(body)) === null;
      expect({ pipeAccepts, checkerAccepts }).toEqual({ pipeAccepts, checkerAccepts: pipeAccepts });
    });
  });
});
