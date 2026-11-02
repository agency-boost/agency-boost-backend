import { FileUploadInterceptor, type FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { PRODUCTION_UPLOAD } from '@/domain/constants';
import { PRODUCTION_REFUSALS } from './production.messages';

/** The one file a preview reads, held in memory: `buffer` is the bytes as they arrived — a CSV or a workbook. */
export type { FileUpload };

/**
 * `multipart/form-data`, one field called `file`, at most `PRODUCTION_UPLOAD.MAX_BYTES` — the shared interceptor
 * (`common/spreadsheet/file-upload.interceptor.ts`), with the Data upload's ceiling and words. Generalised from this
 * file on 2026-11-01 (ADR-0184), when the roster's file came to be received the same way.
 */
export const ProductionUploadInterceptor = FileUploadInterceptor({
  maxBytes: PRODUCTION_UPLOAD.MAX_BYTES,
  tooLarge: PRODUCTION_REFUSALS.ASSET_TOO_LARGE.fileTooLarge({ mb: PRODUCTION_UPLOAD.MAX_BYTES / 1024 / 1024 }),
  notAForm: PRODUCTION_REFUSALS.VALIDATION_FAILED.notAForm,
});
