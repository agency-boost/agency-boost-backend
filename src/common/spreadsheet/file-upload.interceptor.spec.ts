import { BadRequestException, PayloadTooLargeException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { refusals } from '@/common/i18n/sentence';
import { FileUploadInterceptor } from './file-upload.interceptor';

const SAY = refusals('common/spreadsheet interceptor spec', {
  ASSET_TOO_LARGE: { big: { en: 'Too big.', id: 'Terlalu besar.' } },
  VALIDATION_FAILED: { form: { en: 'Not a form.', id: 'Bukan formulir.' } },
});

/**
 * The upload interceptor each import names its ceiling and words to (ADR-0184). Over HTTP, the Data upload's and the
 * roster's integration suites send real forms through it; here, each way multer can fail is put to it directly.
 */
describe('FileUploadInterceptor', () => {
  const Upload = FileUploadInterceptor({ maxBytes: 1024, tooLarge: SAY.ASSET_TOO_LARGE.big, notAForm: SAY.VALIDATION_FAILED.form });

  /** The interceptor, with multer's own replaced by one that answers `outcome`. */
  const failingWith = (outcome: unknown) => {
    const interceptor = new Upload();
    (interceptor as unknown as { multipart: { intercept: () => Promise<unknown> } }).multipart = {
      intercept: () => (outcome instanceof Error || typeof outcome === 'object' ? Promise.reject(outcome) : Promise.resolve(outcome)),
    };
    return interceptor.intercept({} as ExecutionContext, { handle: () => of(null) } as CallHandler);
  };

  it('hands the request on when the form reads', async () => {
    const interceptor = new Upload();
    const handled = of('handled');
    (interceptor as unknown as { multipart: { intercept: () => Promise<unknown> } }).multipart = {
      intercept: () => Promise.resolve(handled),
    };
    await expect(interceptor.intercept({} as ExecutionContext, { handle: () => handled } as CallHandler)).resolves.toBe(handled);
  });

  it('answers a file over the ceiling ASSET_TOO_LARGE, in the import’s words, naming the ceiling', async () => {
    for (const thrown of [new PayloadTooLargeException(), Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' })]) {
      await expect(failingWith(thrown)).rejects.toMatchObject({
        code: 'ASSET_TOO_LARGE', status: 413, message: 'Too big.', details: { maxBytes: 1024 },
      });
    }
  });

  it('passes on what Nest already mapped', async () => {
    const mapped = new BadRequestException('Multipart: Boundary not found');
    await expect(failingWith(mapped)).rejects.toBe(mapped);
  });

  it('answers anything else thrown while the form is read VALIDATION_FAILED: the form is the caller’s', async () => {
    await expect(failingWith(Object.assign(new Error('Unexpected file field'), { code: 'LIMIT_UNEXPECTED_FILE' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400, message: 'Not a form.', details: { reason: 'Unexpected file field' } });
    await expect(failingWith({ toString: () => 'odd' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'odd' } });
  });
});
