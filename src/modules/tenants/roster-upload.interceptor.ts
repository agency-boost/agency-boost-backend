import { FileUploadInterceptor } from '@/common/spreadsheet/file-upload.interceptor';
import { ROSTER_UPLOAD } from '@/domain/constants';
import { TENANTS_REFUSALS } from './tenants.messages';

/**
 * **The roster as a file** (ADR-0184): `multipart/form-data`, one field called `file` — an Excel workbook or a CSV — at
 * most `ROSTER_UPLOAD.MAX_BYTES`, received exactly as the Data upload's file is (`FileUploadInterceptor`): as bytes,
 * a file over the ceiling `ASSET_TOO_LARGE`, a malformed form `VALIDATION_FAILED`.
 */
export const RosterUploadInterceptor = FileUploadInterceptor({
  maxBytes: ROSTER_UPLOAD.MAX_BYTES,
  tooLarge: TENANTS_REFUSALS.ASSET_TOO_LARGE.rosterTooLarge({ mb: ROSTER_UPLOAD.MAX_BYTES / 1024 / 1024 }),
  notAForm: TENANTS_REFUSALS.VALIDATION_FAILED.rosterNotAForm,
});
