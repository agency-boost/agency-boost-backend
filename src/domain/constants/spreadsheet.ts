/**
 * **A workbook somebody uploads** (ADR-0184): the bounds an `.xlsx` is held to before, and while, it is read.
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.31 and pinned by `spreadsheet.spec.ts`. Read by
 * `common/spreadsheet/zip-guard.ts` and `read-xlsx.ts`, which the roster import and the Data upload both go through.
 *
 * **Why bounds on what is inside, not only on the file.** An `.xlsx` is a ZIP, and a ZIP of a megabyte can unpack to a
 * gigabyte: the upload's own byte ceiling (`PRODUCTION_UPLOAD.MAX_BYTES`, `ROSTER_UPLOAD.MAX_BYTES`) says nothing about
 * that. So the archive's directory is read first, without inflating anything, and a workbook whose parts add up to more
 * than `MAX_UNCOMPRESSED_BYTES`, or that has more than `MAX_ENTRIES` parts, is refused before a byte of it is unpacked.
 */
export const SPREADSHEET = {
  /**
   * 25 MiB: the most a workbook's parts may add up to, unpacked, as its own directory declares them. The template of a
   * whole office is well under a megabyte unpacked — about 2 KB a member — so this is ten thousand rows several times
   * over, and the wrong file long before it is a large office.
   */
  MAX_UNCOMPRESSED_BYTES: 25 * 1024 * 1024,
  /** The most parts a workbook may hold. A plain workbook holds about a dozen: sheets, styles, shared strings. */
  MAX_ENTRIES: 1_000,
  /**
   * The most rows a data sheet may hold, its header included. The same ten thousand a megabyte of CSV holds
   * (`PRODUCTION_UPLOAD`), and twenty times the largest office `performance-and-scale.md` plans for.
   */
  MAX_ROWS: 10_000,
  /**
   * The furthest column a data sheet may hold a value in. The roster has nine and the Data upload fourteen; a value
   * past the hundredth (`CV`) is the wrong file. Bounding it is what bounds the rows read: a row is as wide as its last
   * value, so one value in the sheet's last column would otherwise make every row sixteen thousand cells.
   */
  MAX_COLUMNS: 100,
  /**
   * **The sheet the rows are read from, in both languages.** `Data` is Indonesian as well as English, so the template
   * names it once and a reader of either language finds it; the guide beside it is named in the reader's language
   * (`Petunjuk`, `Guide`) and is never read.
   */
  DATA_SHEET: 'Data',
} as const;

/** The MIME type an `.xlsx` is served and recognised as. */
export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * **The roster file, as an upload** (ADR-0184): how large a file `/people/import` and the Super Admin's *Import a
 * roster* accept, and how long the pasted text may be. Documented in §B.31 beside `SPREADSHEET`.
 */
export const ROSTER_UPLOAD = {
  /**
   * 1 MiB, the Data upload's own ceiling. A roster row is about a hundred bytes as CSV and a filled template of five
   * hundred people about 40 KB as a workbook, so this is the wrong file well before it is a large office. Refused with
   * `ASSET_TOO_LARGE` before a byte is read.
   */
  MAX_BYTES: 1024 * 1024,
  /**
   * The most characters the pasted rows (`RosterRowsDto.rows`) may hold: 500,000, a roster of tens of thousands and
   * far past the 500-member office `performance-and-scale.md` sets. The literal `512_000` in the DTO until 2026-11-01.
   */
  MAX_TEXT_LENGTH: 512_000,
} as const;

/**
 * **The invitation a member import sends a new person** (P19.3-T4, ADR-0205 §10): a one-time link to choose their
 * password, through the reset link's mechanism (P4-T14). Seven days, because an invitation waits for somebody who has
 * not asked for it, where a reset link (30 minutes) answers somebody who just did. After it, *Lupa kata sandi?* with the
 * same address proves the mailbox the same way. Documented in §B.31 beside `ROSTER_UPLOAD`.
 */
export const ROSTER_INVITATION = {
  TTL_DAYS: 7,
} as const;
