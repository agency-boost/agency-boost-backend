import {
  CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { PRODUCTION_UPLOAD } from '@/domain/constants';
import { PRODUCTION_REFUSALS } from './production.messages';

/** The one file a preview reads, held in memory: `buffer` is the bytes as they arrived. */
export interface UploadedCsv {
  buffer: Buffer;
  originalname: string;
  size: number;
}

const Multipart = FileInterceptor('file', {
  limits: { fileSize: PRODUCTION_UPLOAD.MAX_BYTES, files: 1 },
});

/**
 * `multipart/form-data`, one field called `file`, at most `PRODUCTION_UPLOAD.MAX_BYTES`.
 *
 * **Bytes, not text.** The upload is decoded on the server, where a byte the encoding cannot explain
 * can still be read the other way (ADR-0052). A browser's `FileReader.readAsText` would have turned
 * it into U+FFFD first.
 *
 * **A file over the ceiling is `ASSET_TOO_LARGE`**, the code every other upload in the product uses.
 * Multer says so with a bare `PayloadTooLargeException`, which the error filter renders as
 * `INTERNAL_ERROR` — a refusal reported as a fault. Translated here, where the limit is set.
 *
 * **Every other multipart failure is the caller's form, and is `VALIDATION_FAILED`.** Nest 10 maps
 * multer's errors by their *message*, and the multer this repository pins (≥ 2.2, a security
 * override) reworded them — `"Unexpected field"` became `"Unexpected file field"` — so a file sent
 * under the wrong name escaped the mapping and answered 500. Found by this route's own test. The
 * `code` multer sets did not change, so that is what is read here; anything thrown while the form is
 * read is the form's fault, because the handler has not run yet.
 *
 * Guards run before interceptors, so a caller without the grant is refused before the body is read.
 */
@Injectable()
export class ProductionUploadInterceptor implements NestInterceptor {
  private readonly multipart = new Multipart();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.multipart.intercept(context, next);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (err instanceof PayloadTooLargeException || code === 'LIMIT_FILE_SIZE') {
        throw new DomainException(
          ErrorCode.ASSET_TOO_LARGE,
          PRODUCTION_REFUSALS.ASSET_TOO_LARGE.fileTooLarge({ mb: PRODUCTION_UPLOAD.MAX_BYTES / 1024 / 1024 }),
          HttpStatus.PAYLOAD_TOO_LARGE,
          { maxBytes: PRODUCTION_UPLOAD.MAX_BYTES },
        );
      }
      // What Nest did map is already a 400, which the filter renders as `VALIDATION_FAILED`.
      if (err instanceof HttpException) throw err;
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        PRODUCTION_REFUSALS.VALIDATION_FAILED.notAForm,
        HttpStatus.BAD_REQUEST,
        { reason: err instanceof Error ? err.message : String(err) },
      );
    }
  }
}
