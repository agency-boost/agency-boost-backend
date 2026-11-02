import {
  CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, mixin, NestInterceptor, PayloadTooLargeException,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';

/** The one file an import reads, held in memory: `buffer` is the bytes as they arrived — a CSV or a workbook. */
export interface FileUpload {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface FileUploadOptions {
  /** The file's ceiling, in bytes: refused before a byte of it is read. */
  maxBytes: number;
  /** What a file over the ceiling is told — the import's own words, naming the ceiling. */
  tooLarge: Sentence<'ASSET_TOO_LARGE'>;
  /** What a request that is not the expected form is told. */
  notAForm: Sentence<'VALIDATION_FAILED'>;
}

/**
 * **`multipart/form-data`, one field called `file`, at most `maxBytes`** — the Data upload's interceptor, made one an
 * import names its ceiling and its words to (ADR-0184), so the roster's file is received the way the production file is.
 *
 * **Bytes, not text.** The upload is decoded on the server, where a byte the encoding cannot explain can still be read
 * the other way (ADR-0052), and where a workbook is opened at all (ADR-0184). A browser's `FileReader.readAsText` would
 * have turned it into U+FFFD first, and a workbook into nonsense.
 *
 * **A file over the ceiling is `ASSET_TOO_LARGE`**, the code every other upload in the product uses. Multer says so with
 * a bare `PayloadTooLargeException`, which the error filter renders as `INTERNAL_ERROR` — a refusal reported as a fault.
 * Translated here, where the limit is set.
 *
 * **Every other multipart failure is the caller's form, and is `VALIDATION_FAILED`.** Nest 10 maps multer's errors by
 * their *message*, and the multer this repository pins (≥ 2.2, a security override) reworded them — `"Unexpected field"`
 * became `"Unexpected file field"` — so a file sent under the wrong name escaped the mapping and answered 500. The `code`
 * multer sets did not change, so that is what is read here; anything thrown while the form is read is the form's fault,
 * because the handler has not run yet.
 *
 * Guards run before interceptors, so a caller without the grant is refused before the body is read.
 */
export function FileUploadInterceptor(options: FileUploadOptions): Type<NestInterceptor> {
  const Multipart = FileInterceptor('file', { limits: { fileSize: options.maxBytes, files: 1 } });

  @Injectable()
  class Upload implements NestInterceptor {
    private readonly multipart = new Multipart();

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      try {
        return await this.multipart.intercept(context, next);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (err instanceof PayloadTooLargeException || code === 'LIMIT_FILE_SIZE') {
          throw new DomainException(
            ErrorCode.ASSET_TOO_LARGE, options.tooLarge, HttpStatus.PAYLOAD_TOO_LARGE, { maxBytes: options.maxBytes },
          );
        }
        // What Nest did map is already a 400, which the filter renders as `VALIDATION_FAILED`.
        if (err instanceof HttpException) throw err;
        throw new DomainException(
          ErrorCode.VALIDATION_FAILED,
          options.notAForm,
          HttpStatus.BAD_REQUEST,
          { reason: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  return mixin(Upload);
}
