import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_LIMITS, HTML_MIME_TYPE, LESSON_COLOUR_VALUE, LESSON_COLOUR_VARIABLES, LESSONS,
} from '@/domain/constants';
import { SNIFF_SAMPLE_BYTES, sniffedContentType } from '@/modules/assets/content-sniff';

/**
 * **The owner's lessons, read from the folder they were delivered in** (P19.6-T3; the 11-03 handover's §B6;
 * `revisions/2026-11-03/files/training-modules/`).
 *
 * The folder holds `index.html` and one folder per lesson, `<nn>-<slug>/`, each with `default.html` and its A4
 * `default.pdf`; `_pdf-upload/` holds the same PDFs under the names they were uploaded with in production
 * (`"01 Leads generation - … .pdf"`). **The folder is frozen input, read and never written**: what is stored is a
 * served copy, made here.
 *
 * - **`index.html` is the mapping's source** (AC-6): each lesson's number, folder, title and category, in that file's
 *   order. It is never uploaded as material.
 * - **The served copy carries one small script** (AC-5, AC-7; ADR-0217 §4, §5), inserted before `</head>`: the colour
 *   reader, so the KPM's colours are on `:root` before the lesson's first paint, and the scroll keeper, so the lesson's
 *   links move the lesson and never the page around it. Nothing else of the lesson changes.
 */

/** One row of `index.html`. */
export interface LessonIndexEntry {
  /** 1 to 23: the index's own number, and its folder's prefix. */
  number: number;
  /** `01-leads-generation-tactics`. */
  folder: string;
  /** The index's title, entities decoded: *"Leads generation: 8 cara mendapat calon nasabah"*. */
  title: string;
  /** The index's heading the lesson sits under: *Sales*, *Produk*, … *Perusahaan dan agency*. */
  category: string;
}

/** A lesson, ready to store: its served copy and its PDF, each with the object name it is stored under. */
export interface Lesson extends LessonIndexEntry {
  /** The served copy: the delivered `default.html` with the colour reader. */
  html: Buffer;
  /** `<folder>-<hash>.html`, the hash the served copy's. */
  htmlName: string;
  /** The delivered `default.pdf`, or `null` where the folder has none. */
  pdf: Buffer | null;
  pdfName: string | null;
  /**
   * The sizes this lesson's PDF was delivered at — `default.pdf` and its `_pdf-upload/` copy — which is how a KPM's
   * own PDF is recognised as this lesson (`lessonMapFromOffice`).
   */
  pdfSizes: number[];
}

export interface LessonSet {
  /** In the index's order. */
  lessons: Lesson[];
}

/** The folder cannot be read as a set of lessons: what is wrong, in the operator's words. */
export class LessonFilesError extends Error {}

/** The served copy's marker: a lesson that carries it already is not given the script a second time. */
export const LESSON_READER_MARKER = 'data-agencyboost-lesson';

/**
 * **The reader of ADR-0217 §5**: it reads `location.hash` once, takes only the three names with six lower-case
 * hexadecimal digits each, and sets them on `:root`. It decides nothing — the API chose the values — and it never
 * touches a status colour. A lesson opened with no fragment keeps its own colours.
 */
export const LESSON_COLOUR_READER = `var names=${JSON.stringify(LESSON_COLOUR_VARIABLES)};`
  + 'location.hash.slice(1).split("&").forEach(function(pair){'
  + 'var at=pair.indexOf("=");if(at<1)return;var name=pair.slice(0,at),value=pair.slice(at+1);'
  + `if(Object.prototype.hasOwnProperty.call(names,name)&&/${LESSON_COLOUR_VALUE.source}/.test(value)){`
  + 'document.documentElement.style.setProperty(names[name],"#"+value);}'
  + '});';

/**
 * **The lesson's scrolling stays inside its frame** (AC-7; ADR-0217 §4, *"the lesson's own script keeps its anchor
 * links inside it"*). The delivered lessons move to a part with `scrollIntoView`, which a browser also applies to every
 * box around the frame: in Chrome the page behind the lesson's window scrolled with each of the 23 lessons' links
 * (found by `lessons.browser.spec.ts`, 2026-11-06). In the served copy, `scrollIntoView` scrolls the lesson's own page
 * to the element, smoothly where it was asked to, and nothing else. The lesson's code is not changed.
 */
export const LESSON_SCROLL_KEEPER = 'if(typeof Element!=="undefined"&&Element.prototype.scrollIntoView){'
  + 'Element.prototype.scrollIntoView=function(how){var box=this.getBoundingClientRect();'
  + 'window.scrollTo({top:box.top+window.pageYOffset,left:window.pageXOffset,'
  + 'behavior:how&&typeof how==="object"&&how.behavior==="smooth"?"smooth":"auto"});};}';

/** What the served copy carries before `</head>`: the colour reader, and the scroll keeper. */
export const LESSON_SERVED_SCRIPT = `<script ${LESSON_READER_MARKER}>(function(){${LESSON_COLOUR_READER}${LESSON_SCROLL_KEEPER}})();</script>`;

/**
 * **A lesson's served copy** (AC-5, AC-7): the script inserted before `</head>`, once, so it runs before the lesson's
 * first paint and before the lesson's own script. A lesson with no `</head>` is refused rather than given the script
 * somewhere it may not run first.
 */
export function servedLesson(html: string): string {
  if (html.includes(LESSON_READER_MARKER)) return html;
  const at = html.search(/<\/head\s*>/i);
  if (at < 0) throw new LessonFilesError('A lesson has no </head>, so the colour reader has nowhere to go.');
  return `${html.slice(0, at)}${LESSON_SERVED_SCRIPT}\n${html.slice(at)}`;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/** `&amp;`, `&#39;` and `&#x27;` as the characters they are; an unknown name is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const FOLDER = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * **The index's rows** (AC-6): each `<a href="<folder>/default.html">` with its `num` and `ttl`, under the `<h2>` before
 * it. A folder is `<nn>-<slug>`, its prefix the row's number, so nothing outside the folder is ever read. Refused when
 * it lists nothing, a number twice, or a row under no heading.
 */
export function readLessonIndex(html: string): LessonIndexEntry[] {
  const rows: LessonIndexEntry[] = [];
  let category: string | null = null;
  const pattern = /<h2[^>]*>([^<]*)<\/h2>|<a\s+href="([^"]+)\/default\.html"[^>]*>\s*<span class="num">\s*(\d+)\s*<\/span>\s*<span class="ttl">([^<]*)<\/span>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== undefined) {
      category = decodeEntities(match[1]).trim();
      continue;
    }
    const [, , folder, num, title] = match;
    const number = Number(num);
    const prefix = FOLDER.exec(folder);
    if (!prefix || Number(prefix[1]) !== number) {
      throw new LessonFilesError(`index.html lists "${folder}" as lesson ${num}: a folder is "<nn>-<name>", its number the row's.`);
    }
    if (!category) throw new LessonFilesError(`index.html lists lesson ${num} under no heading, so it has no category.`);
    if (rows.some((row) => row.number === number)) throw new LessonFilesError(`index.html lists lesson ${num} twice.`);
    rows.push({ number, folder, title: decodeEntities(title).trim(), category });
  }
  if (rows.length === 0) throw new LessonFilesError('index.html lists no lesson.');
  return rows;
}

/** The comparison a module's title is matched by: letters and digits only, lower case, so punctuation never decides. */
export function titleKey(text: string): string {
  return decodeEntities(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const hashOf = (body: Buffer) => createHash('sha256').update(body).digest('hex').slice(0, LESSONS.HASH_DIGITS);

/** `_pdf-upload/<nn> …pdf`'s sizes, by number. */
function uploadedSizes(dir: string): Map<number, number[]> {
  const sizes = new Map<number, number[]>();
  const uploads = join(dir, '_pdf-upload');
  if (!existsSync(uploads)) return sizes;
  for (const name of readdirSync(uploads)) {
    const match = /^(\d{2})\s.*\.pdf$/i.exec(name);
    if (!match) continue;
    const number = Number(match[1]);
    sizes.set(number, [...(sizes.get(number) ?? []), statSync(join(uploads, name)).size]);
  }
  return sizes;
}

/**
 * **The lessons in a folder** (AC-1, AC-6): `index.html`'s rows, each with its served copy and its PDF, checked as the
 * confirm step checks an upload — the served copy is an HTML document by its first bytes, a PDF is a PDF, and each is
 * within `ASSET_LIMITS.MAX_BYTES`. A lesson the index lists and the folder lacks is refused; a missing PDF is not.
 */
export function loadLessonSet(dir: string): LessonSet {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) {
    throw new LessonFilesError(`${dir} holds no index.html: point at the lessons' folder (revisions/2026-11-03/files/training-modules).`);
  }
  const uploads = uploadedSizes(dir);
  const lessons = readLessonIndex(readFileSync(indexPath, 'utf8')).map((entry): Lesson => {
    const htmlPath = join(dir, entry.folder, 'default.html');
    if (!existsSync(htmlPath)) throw new LessonFilesError(`Lesson ${entry.number} has no ${entry.folder}/default.html.`);
    const html = Buffer.from(servedLesson(readFileSync(htmlPath, 'utf8')), 'utf8');
    if (sniffedContentType(HTML_MIME_TYPE, html.subarray(0, SNIFF_SAMPLE_BYTES)) !== HTML_MIME_TYPE) {
      throw new LessonFilesError(`Lesson ${entry.number}'s default.html does not begin as an HTML document.`);
    }
    const pdfPath = join(dir, entry.folder, 'default.pdf');
    const pdf = existsSync(pdfPath) ? readFileSync(pdfPath) : null;
    if (pdf && pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new LessonFilesError(`Lesson ${entry.number}'s default.pdf is not a PDF.`);
    }
    for (const [what, body] of [['default.html', html], ['default.pdf', pdf]] as const) {
      if (body && body.length > ASSET_LIMITS.MAX_BYTES) {
        throw new LessonFilesError(`Lesson ${entry.number}'s ${what} is over ${ASSET_LIMITS.MAX_BYTES} bytes.`);
      }
    }
    return {
      ...entry,
      html,
      htmlName: `${entry.folder}-${hashOf(html)}.html`,
      pdf,
      pdfName: pdf ? `${entry.folder}-${hashOf(pdf)}.pdf` : null,
      pdfSizes: [...new Set([...(pdf ? [pdf.length] : []), ...(uploads.get(entry.number) ?? [])])],
    };
  });
  return { lessons };
}
