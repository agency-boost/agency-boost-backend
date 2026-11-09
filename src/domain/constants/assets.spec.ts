import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ASSET_LIMITS, AVATAR, DEFAULT_UPLOAD_MIME_TYPES, DOCUMENT_MIME_TYPES, HTML_MIME_TYPE, RECRUITMENT,
  TRAINING_FILE_MIME_TYPES,
} from '@/domain/constants';

const SRC = join(__dirname, '..', '..');

/** Every source file under `src/`, specs excluded: what the API runs. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * **Which upload lists may hold HTML, and who names them** (P19.6-T2, ADR-0217 §1).
 *
 * An HTML file runs a script, so it is accepted in four kinds of slot and no other: a training module's *File* — the
 * office's and the template's — the six recruitment pitch documents and an office's three product documents. Every
 * other upload names its own list without it, and a route that names none takes `DEFAULT_UPLOAD_MIME_TYPES`.
 */
describe('P19.6-T2 AC-1 HTML is accepted by four routes and no other (ADR-0217 §1)', () => {
  it('P19.6-T2 AC-1 names text/html once, as a constant', () => {
    expect(HTML_MIME_TYPE).toBe('text/html');
    expect(ASSET_LIMITS.ALLOWED_MIME_TYPES).toContain(HTML_MIME_TYPE);
  });

  it('P19.6-T2 AC-1 a training file takes today’s list and HTML', () => {
    expect([...TRAINING_FILE_MIME_TYPES]).toEqual([
      'image/jpeg', 'image/png', 'image/webp',
      'application/pdf',
      'video/mp4',
      'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/html',
    ]);
  });

  it('P19.6-T2 AC-1 a pitch or product document is a PDF or an HTML page', () => {
    expect([...DOCUMENT_MIME_TYPES]).toEqual(['application/pdf', 'text/html']);
    expect(RECRUITMENT.PITCH_MIME_TYPES).toBe(DOCUMENT_MIME_TYPES);
  });

  it('P19.6-T2 AC-1 a route that names no list takes the vocabulary without HTML', () => {
    expect(DEFAULT_UPLOAD_MIME_TYPES).not.toContain(HTML_MIME_TYPE);
    expect([...DEFAULT_UPLOAD_MIME_TYPES, HTML_MIME_TYPE].sort()).toEqual([...ASSET_LIMITS.ALLOWED_MIME_TYPES].sort());
  });

  it('P19.6-T2 AC-1 the profile photo’s list has no HTML', () => {
    expect(AVATAR.MIME_TYPES).not.toContain(HTML_MIME_TYPE);
  });

  it('P19.6-T2 AC-1 the size ceiling is each slot’s existing one: 25 MB, the same for HTML', () => {
    expect(ASSET_LIMITS.MAX_BYTES).toBe(25 * 1024 * 1024);
  });

  /*
   * The pin. A list that holds HTML is named outside `domain/constants/` and `modules/assets/` only by the services and
   * the DTO of the four routes. A new route that reaches for one fails here, so accepting HTML anywhere else is a
   * deliberate change with an ADR, never a copied line.
   */
  it('P19.6-T2 AC-1 only the four routes’ services and their DTO name a list that holds HTML', () => {
    const lists = /\b(TRAINING_FILE_MIME_TYPES|DOCUMENT_MIME_TYPES|PITCH_MIME_TYPES|ALLOWED_MIME_TYPES)\b/;
    const naming = sources()
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((path) => !path.startsWith('domain/constants/') && !path.startsWith('modules/assets/'))
      .filter((path) => lists.test(readFileSync(join(SRC, path), 'utf8')))
      .sort();
    expect(naming).toEqual([
      // `POST /admin/companies/:companyId/templates/:templateId/training/uploads` (ADR-0208 §1)
      'modules/config/template-material.service.ts',
      // `POST /kpm/settings/products/uploads`
      'modules/products/kpm-product.service.ts',
      // `POST /kpm/settings/recruitment-pitch/uploads`
      'modules/recruitment/recruitment-pitch.service.ts',
      // `POST /kpm/settings/training/uploads`, and the template's route, which takes the same DTO
      'modules/training/training.dto.ts',
      'modules/training/training.service.ts',
    ]);
  });
});
