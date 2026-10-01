import {
  checkTemplateSummaryGroups, refuseSummaryGroupConflict, summaryGroupCodeTaken, summaryGroupConflict,
} from './summary-group';

/**
 * ADR-0064's rule across rows, as a pure function — the edges the service specs do not reach
 * through a database: a label missing where a code is set, and a template payload of the wrong shape.
 */
describe('one summary tile, one label (ADR-0064)', () => {
  it('agrees when every group carries one label, and ignores sections with no tile', () => {
    expect(summaryGroupConflict([
      { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' },
      { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' },
      { summaryGroupCode: null, summaryGroupLabel: null },
      {},
    ])).toBeNull();
    expect(() => refuseSummaryGroupConflict([])).not.toThrow();
  });

  it('reads a code with no label as a disagreement, not as agreement with anything', () => {
    // Nothing valid writes this; a row edited by hand could, and it must not pass as one tile.
    expect(summaryGroupConflict([
      { summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
      { summaryGroupCode: 'CORE' },
    ])).toEqual({ summaryGroupCode: 'CORE', labels: ['Core', ''] });
  });

  it('names the first split group, with its labels in the order met', () => {
    expect(() => refuseSummaryGroupConflict([
      { summaryGroupCode: 'A_TILE', summaryGroupLabel: 'A' },
      { summaryGroupCode: 'B_TILE', summaryGroupLabel: 'B' },
      { summaryGroupCode: 'B_TILE', summaryGroupLabel: 'Bee' },
      { summaryGroupCode: 'A_TILE', summaryGroupLabel: 'Ay' },
    ])).toThrow(expect.objectContaining({
      code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH',
      details: { summaryGroupCode: 'A_TILE', labels: ['A', 'Ay'] },
    }));
  });

  describe('one shared tile, one code (P10.1-T6)', () => {
    it('takes no part for a row with no code, and lets a section carry its own tile’s code', () => {
      expect(summaryGroupCodeTaken([
        { summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' },
        { code: 'DEVELOPMENT', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' },
        { code: 'SELLING', summaryGroupCode: null, summaryGroupLabel: null },
      ])).toBeNull();
    });

    it('names a tile whose code a section outside it carries, with or without a tile of its own', () => {
      const tile = { code: 'PERSONAL', summaryGroupCode: 'DEVELOPMENT', summaryGroupLabel: 'Development' };
      expect(summaryGroupCodeTaken([tile, { code: 'DEVELOPMENT' }]))
        .toEqual({ summaryGroupCode: 'DEVELOPMENT', label: 'Development' });
      expect(summaryGroupCodeTaken([{ code: 'DEVELOPMENT', summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' }, tile]))
        .toEqual({ summaryGroupCode: 'DEVELOPMENT', label: 'Development' });
    });

    it('is refused after the label rule, so a tile both split and taken is named for its labels', () => {
      const rows = [
        { code: 'A', summaryGroupCode: 'CORE', summaryGroupLabel: 'Core' },
        { code: 'B', summaryGroupCode: 'CORE', summaryGroupLabel: 'Inti' },
        { code: 'CORE' },
      ];
      expect(() => refuseSummaryGroupConflict(rows)).toThrow(expect.objectContaining({ code: 'CONFIG_SUMMARY_GROUP_LABEL_MISMATCH' }));
      expect(() => refuseSummaryGroupConflict([rows[0], rows[2]])).toThrow(expect.objectContaining({
        code: 'CONFIG_SUMMARY_GROUP_CODE_TAKEN',
        details: { summaryGroupCode: 'CORE', label: 'Core' },
        message: expect.stringMatching(/^CORE is the code of the summary tile “Core”/),
      }));
    });
  });

  describe('a Company template’s categories', () => {
    it('hands back nothing to check when there is no list', () => {
      expect(checkTemplateSummaryGroups(undefined)).toEqual([]);
      expect(checkTemplateSummaryGroups({ categories: [] })).toEqual([]);
    });

    it('reads a missing pair as none, and keeps everything else on the row', () => {
      expect(checkTemplateSummaryGroups([{ code: 'SELLING', label: 'Selling', displayOrder: 2 }]))
        .toEqual([{
          code: 'SELLING', label: 'Selling', displayOrder: 2, summaryGroupCode: null, summaryGroupLabel: null,
        }]);
    });

    it('leaves a row that is not a section to the rest of the payload’s checks, and refuses a pair that is not text', () => {
      // Not this rule's to refuse, and not its to rewrite: a row that is not an object is kept as sent.
      expect(checkTemplateSummaryGroups(['SELLING', null])).toEqual(['SELLING', null]);
      expect(() => checkTemplateSummaryGroups([
        { summaryGroupCode: 7, summaryGroupLabel: 'Seven' },
        { code: 'RECRUITMENT', summaryGroupCode: 'CORE', summaryGroupLabel: 7 },
      ])).toThrow(expect.objectContaining({
        code: 'VALIDATION_FAILED',
        details: {
          violations: [
            expect.stringMatching(/^categories\[0\]: summaryGroupCode: A code is/),
            'categories[1] (RECRUITMENT): summaryGroupLabel must be 1–80 characters.',
          ],
        },
      }));
    });
  });
});
