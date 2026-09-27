/**
 * The monthly production upload (P9-T3).
 *
 * **Why a ceiling at all.** The file is read into memory and parsed in one request, so something has
 * to bound it — and the bound is generous on purpose. A row of the template is about a hundred bytes;
 * a megabyte is ten thousand agents, which is more than any office this product serves. A file that
 * size is not a bigger office, it is the wrong file.
 */
export const PRODUCTION_UPLOAD = {
  /** 1 MiB. Refused with `ASSET_TOO_LARGE` before a byte of it is parsed. */
  MAX_BYTES: 1024 * 1024,
} as const;
