import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';

/**
 * **The Super Admin's guide, as the owner delivered it** (P19.6-T5; ADR-0219 §1, §4; §B6: *"The Super Admin guide is
 * INTERNAL: only Super Admins can open it, and it must never be reachable by a public link"*).
 *
 * The two files live in **this repository and its image alone** — `backend/assets/panduan/`, copied byte for byte from
 * `revisions/<date>/files/guides/panduan-super-admin-INTERNAL-<date>.*` by the superproject's `scripts/sync-guides.py`
 * (OD-271: served as delivered) — never in the frontend's repository, a `public/` folder or storage. A refresh keeps
 * these names, so nothing here changes with it.
 */
export const SUPER_ADMIN_GUIDE = {
  html: 'super-admin.html',
  pdf: 'super-admin.pdf',
  /** The name the PDF is saved under: no date, so the file a reader keeps is named as the one they open. */
  pdfDownloadName: 'panduan-super-admin.pdf',
} as const;

/**
 * **`backend/assets/panduan/`**, found from here upward: `src/modules/guides` in a test, `dist/modules/guides` in the
 * image, whose `assets/` the Dockerfile copies beside `dist/` (as the proposal PDF's fonts are found).
 */
export function guidesDirectory(from: string = __dirname): string {
  let at = from;
  for (;;) {
    const candidate = join(at, 'assets', 'panduan');
    if (existsSync(join(candidate, SUPER_ADMIN_GUIDE.html))) return candidate;
    const up = dirname(at);
    if (up === at) throw new Error('The Super Admin guide is missing: assets/panduan/super-admin.html (scripts/sync-guides.py)');
    at = up;
  }
}

/**
 * **Reads the two files once, the first time each is asked for**, and answers the same bytes from memory after that: the
 * files change only with a deploy. Nothing about the reader is read or written, and nothing is recorded — a guide is
 * documentation, with no member's data in it (ADR-0219, *Decision*).
 */
@Injectable()
export class SuperAdminGuide {
  private readonly cache = new Map<string, Buffer>();

  /** The guide's HTML, exactly as delivered. */
  html(): Buffer {
    return this.file(SUPER_ADMIN_GUIDE.html);
  }

  /** The guide's PDF, exactly as delivered. */
  pdf(): Buffer {
    return this.file(SUPER_ADMIN_GUIDE.pdf);
  }

  private file(name: string): Buffer {
    const held = this.cache.get(name);
    if (held) return held;
    const bytes = readFileSync(join(guidesDirectory(), name));
    this.cache.set(name, bytes);
    return bytes;
  }
}
