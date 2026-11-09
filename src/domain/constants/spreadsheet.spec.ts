import { PRODUCTION_UPLOAD, ROSTER_INVITATION, ROSTER_UPLOAD, SPREADSHEET, XLSX_MIME_TYPE } from './index';

/**
 * A workbook's bounds and the roster upload's (ADR-0184), pinned so a change fails here before it reaches a reader.
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.31.
 */
describe('the spreadsheet bounds (ADR-0184)', () => {
  it('pins what a workbook may unpack to, hold and list', () => {
    expect(SPREADSHEET).toEqual({
      MAX_UNCOMPRESSED_BYTES: 26_214_400,
      MAX_ENTRIES: 1_000,
      MAX_ROWS: 10_000,
      MAX_COLUMNS: 100,
      DATA_SHEET: 'Data',
    });
  });

  it('pins the roster upload: a file of a megabyte, and pasted rows of 512,000 characters', () => {
    expect(ROSTER_UPLOAD).toEqual({ MAX_BYTES: 1_048_576, MAX_TEXT_LENGTH: 512_000 });
  });

  it('P19.3-T4 AC-11 pins the member import’s invitation link: seven days (§B.31, ADR-0205 §10)', () => {
    expect(ROSTER_INVITATION).toEqual({ TTL_DAYS: 7 });
  });

  it('holds the roster file to the Data upload’s ceiling, so the two imports refuse the same size alike', () => {
    expect(ROSTER_UPLOAD.MAX_BYTES).toBe(PRODUCTION_UPLOAD.MAX_BYTES);
  });

  it('caps the rows at what a megabyte of the Data upload’s CSV holds', () => {
    // A template row is about a hundred bytes (§B.10), so the file's ceiling and the row cap say the same thing.
    expect(SPREADSHEET.MAX_ROWS).toBe(Math.round(PRODUCTION_UPLOAD.MAX_BYTES / 100 / 1000) * 1000);
  });

  it('names the type an .xlsx is', () => {
    expect(XLSX_MIME_TYPE).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});
