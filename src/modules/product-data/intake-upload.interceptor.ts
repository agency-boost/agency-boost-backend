import {
  CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor, PayloadTooLargeException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Observable } from 'rxjs';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { FileUploadInterceptor } from '@/common/spreadsheet/file-upload.interceptor';
import { ILLUSTRATION, INTAKE } from '@/domain/constants';
import { INTAKE_REFUSALS } from './intake.messages';

const SAY = INTAKE_REFUSALS;
const Multipart = FilesInterceptor('files', INTAKE.FILES_MAX, { limits: { fileSize: INTAKE.FILE_MAX_BYTES, files: INTAKE.FILES_MAX } });

/**
 * ***Unggah file*'s form** (P19.15-T3 AC-1): `multipart/form-data`, the field `files`, up to `INTAKE.FILES_MAX` files of
 * `INTAKE.FILE_MAX_BYTES` each — as the Data upload's interceptor does for one file (ADR-0184): a file over the bound is
 * `ASSET_TOO_LARGE`, too many files and every other form failure `VALIDATION_FAILED`, before the handler runs. Guards run
 * first, so a caller without the grant is refused before the body is read.
 */
@Injectable()
export class IntakeUploadInterceptor implements NestInterceptor {
  private readonly multipart = new Multipart();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.multipart.intercept(context, next);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (err instanceof PayloadTooLargeException || code === 'LIMIT_FILE_SIZE') {
        throw new DomainException(
          ErrorCode.ASSET_TOO_LARGE, SAY.ASSET_TOO_LARGE.fileTooLarge({ name: 'file', mb: INTAKE.FILE_MAX_BYTES / 1024 / 1024 }),
          HttpStatus.PAYLOAD_TOO_LARGE, { maxBytes: INTAKE.FILE_MAX_BYTES },
        );
      }
      if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
        throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.tooManyFiles({ max: INTAKE.FILES_MAX }), HttpStatus.BAD_REQUEST, {
          field: 'files', max: INTAKE.FILES_MAX,
        });
      }
      if (err instanceof HttpException) throw err;
      throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.VALIDATION_FAILED.noFiles, HttpStatus.BAD_REQUEST, {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** The *Ilustrasi* tab's form: one PDF, `file`, at most `ILLUSTRATION.FILE_MAX_BYTES`. */
export const IllustrationUploadInterceptor = FileUploadInterceptor({
  maxBytes: ILLUSTRATION.FILE_MAX_BYTES,
  tooLarge: SAY.ASSET_TOO_LARGE.fileTooLarge({ name: 'PDF', mb: ILLUSTRATION.FILE_MAX_BYTES / 1024 / 1024 }),
  notAForm: SAY.VALIDATION_FAILED.noFiles,
});
