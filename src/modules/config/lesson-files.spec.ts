import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ASSET_LIMITS } from '@/domain/constants';
import { SNIFF_SAMPLE_BYTES, sniffedContentType } from '@/modules/assets/content-sniff';
import { DELIVERED_LESSONS, lessonHtml, pdfSize, writeLessonFolder } from '../../../test/lesson-folder';
import {
  decodeEntities, LESSON_COLOUR_READER, LESSON_READER_MARKER, LESSON_SCROLL_KEEPER, LESSON_SERVED_SCRIPT, LessonFilesError,
  loadLessonSet, readLessonIndex, servedLesson, titleKey,
} from './lesson-files';

/** The superproject's delivered folder, where a laptop has it; a CI checkout of the backend alone does not. */
const DELIVERED = resolve(__dirname, '../../../../revisions/2026-11-03/files/training-modules');
const delivered = existsSync(join(DELIVERED, 'index.html'));

/**
 * Run the served copy's script as a browser would, against a fragment: what it set on `:root`. `document` and
 * `location` are the only things the reader may touch; with no `Element`, the scroll keeper does nothing.
 */
function readerSets(hash: string): Record<string, string> {
  const set: Record<string, string> = {};
  runInNewContext(LESSON_SERVED_SCRIPT.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), {
    location: { hash },
    document: { documentElement: { style: { setProperty: (name: string, value: string) => { set[name] = value; } } } },
  });
  return set;
}

describe('the lessons’ folder (P19.6-T3)', () => {
  describe('index.html, the mapping’s source (AC-6)', () => {
    it('P19.6-T3 AC-6 reads each row’s number, folder, title and heading, entities decoded, in the index’s order', () => {
      const folder = writeLessonFolder();
      try {
        const rows = readLessonIndex(readFileSync(join(folder.dir, 'index.html'), 'utf8'));
        expect(rows).toHaveLength(23);
        expect(rows.map((r) => r.number)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
        expect(rows[1]).toEqual({
          number: 2, folder: '02-media-sosial-leads-tracker',
          title: 'Media sosial & leads tracker: dari konten ke janji temu', category: 'Sales',
        });
        expect(rows.map((r) => r.category)).toEqual(DELIVERED_LESSONS.map((l) => l.category));
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-6 refuses an index that lists nothing, a number twice, a folder outside its pattern, or a row under no heading', () => {
      const row = (href: string, n: string) => `<a href="${href}/default.html"><span class="num">${n}</span><span class="ttl">T</span></a>`;
      expect(() => readLessonIndex('<html></html>')).toThrow(LessonFilesError);
      expect(() => readLessonIndex(`<h2>Sales</h2>${row('01-a', '01')}${row('01-a', '01')}`)).toThrow(/twice/);
      expect(() => readLessonIndex(`<h2>Sales</h2>${row('../etc', '01')}`)).toThrow(/folder/);
      expect(() => readLessonIndex(`<h2>Sales</h2>${row('02-a', '01')}`)).toThrow(/folder/);
      expect(() => readLessonIndex(row('01-a', '01'))).toThrow(/no heading/);
    });

    it.each([['&amp;', '&'], ['&#39;', '\''], ['&#x27;', '\''], ['&lt;b&gt;', '<b>'], ['&unknown;', '&unknown;']])(
      'P19.6-T3 AC-6 decodes %s as %s',
      (written, read) => expect(decodeEntities(written)).toBe(read),
    );

    (delivered ? it : it.skip)('P19.6-T3 AC-6 the delivered index lists the 23 lessons the training spec’s table names', () => {
      const rows = readLessonIndex(readFileSync(join(DELIVERED, 'index.html'), 'utf8'));
      expect(rows.map(({ folder, title, category }) => ({ folder, title, category }))).toEqual(DELIVERED_LESSONS);
    });
  });

  describe('the served copy and its colour reader (AC-5)', () => {
    it('P19.6-T3 AC-5 inserts the reader once, before </head>, and changes nothing else of the lesson', () => {
      const html = lessonHtml('Leads generation: 8 cara mendapat calon nasabah');
      const served = servedLesson(html);
      expect(served.indexOf(LESSON_READER_MARKER)).toBeLessThan(served.indexOf('</head>'));
      expect(served.replace(`${LESSON_SERVED_SCRIPT}\n`, '')).toBe(html);
      expect(LESSON_SERVED_SCRIPT).toContain(LESSON_COLOUR_READER);
      expect(LESSON_SERVED_SCRIPT).toContain(LESSON_SCROLL_KEEPER);
      expect(servedLesson(served)).toBe(served);
      // Still an HTML document by its first bytes, as storage's confirm reads it (ADR-0217 §2).
      expect(sniffedContentType('text/html', Buffer.from(served).subarray(0, SNIFF_SAMPLE_BYTES))).toBe('text/html');
    });

    it('P19.6-T3 AC-5 refuses a lesson with no </head>, which the reader could not run first in', () => {
      expect(() => servedLesson('<!doctype html><html><body>x</body></html>')).toThrow(LessonFilesError);
    });

    it('P19.6-T3 AC-5 the reader sets the primary as --accent, its tint as --accent-soft and the secondary as --ink', () => {
      expect(readerSets('#accent=0e7c66&accentSoft=eef7f5&ink=1f2a44')).toEqual({
        '--accent': '#0e7c66', '--accent-soft': '#eef7f5', '--ink': '#1f2a44',
      });
      // The API leaves `ink` out where white does not read on the secondary: the lesson keeps its own.
      expect(readerSets('#accent=0e7c66&accentSoft=eef7f5')).toEqual({ '--accent': '#0e7c66', '--accent-soft': '#eef7f5' });
    });

    it('P19.6-T3 AC-5 without a fragment the lesson keeps its own colours: the reader sets nothing', () => {
      expect(readerSets('')).toEqual({});
      expect(readerSets('#bagian-2')).toEqual({});
    });

    it('P19.6-T3 AC-7 the scroll keeper moves the lesson’s own page to the element, smoothly where asked, and no box around the frame', () => {
      const scrolled: unknown[] = [];
      class Element {
        scrollIntoView(_how?: unknown): void {
          throw new Error('the browser’s own scrollIntoView would scroll the page around the frame too');
        }
        getBoundingClientRect() { return { top: 120 }; }
      }
      const window = { pageYOffset: 300, pageXOffset: 0, scrollTo: (to: unknown) => { scrolled.push(to); } };
      runInNewContext(LESSON_SCROLL_KEEPER, { Element, window });
      new Element().scrollIntoView({ behavior: 'smooth', block: 'start' });
      new Element().scrollIntoView();
      expect(scrolled).toEqual([{ top: 420, left: 0, behavior: 'smooth' }, { top: 420, left: 0, behavior: 'auto' }]);
    });

    it('P19.6-T3 AC-5 the reader decides nothing: another name, a status colour, or a value not six lower-case hex digits is ignored', () => {
      expect(readerSets('#green=000000&red=000000&accent=ABCDEF&accentSoft=12345&ink=1f2a44zz&toString=000000')).toEqual({});
      expect(readerSets('#accent=0e7c66;background:red')).toEqual({});
      expect(readerSets('#=0e7c66&accent')).toEqual({});
    });
  });

  describe('a folder of lessons', () => {
    it('P19.6-T3 AC-1 reads each lesson’s served copy and its PDF, names each by its hash, and knows the sizes its PDF was delivered at', () => {
      const folder = writeLessonFolder();
      try {
        const set = loadLessonSet(folder.dir);
        expect(set.lessons).toHaveLength(23);
        const first = set.lessons[0];
        expect(first.html.toString('utf8')).toContain(LESSON_READER_MARKER);
        const hash = createHash('sha256').update(first.html).digest('hex').slice(0, 12);
        expect(first.htmlName).toBe(`01-leads-generation-tactics-${hash}.html`);
        expect(first.pdfName).toMatch(/^01-leads-generation-tactics-[0-9a-f]{12}\.pdf$/);
        expect(first.pdf!.length).toBe(pdfSize(1));
        expect(first.pdfSizes).toEqual([pdfSize(1)]);
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-5 the delivered files stay as delivered: reading them writes nothing back', () => {
      const folder = writeLessonFolder({ count: 2 });
      try {
        const path = join(folder.dir, '01-leads-generation-tactics', 'default.html');
        const before = readFileSync(path);
        loadLessonSet(folder.dir);
        expect(readFileSync(path).equals(before)).toBe(true);
        expect(before.toString('utf8')).not.toContain(LESSON_READER_MARKER);
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-1 a refreshed lesson is a new file name; an unchanged one keeps its name', () => {
      const a = writeLessonFolder({ count: 1 });
      const b = writeLessonFolder({ count: 1 });
      const c = writeLessonFolder({ count: 1, marker: 'Diperbarui' });
      try {
        const [one, two, three] = [a, b, c].map((f) => loadLessonSet(f.dir).lessons[0]);
        expect(two.htmlName).toBe(one.htmlName);
        expect(three.htmlName).not.toBe(one.htmlName);
        expect(three.pdfName).toBe(one.pdfName);
      } finally {
        [a, b, c].forEach((f) => f.remove());
      }
    });

    it('P19.6-T3 AC-1 a lesson without its PDF is read with none; a PDF that is not one is refused', () => {
      const folder = writeLessonFolder({ count: 3, withoutPdf: [2] });
      try {
        rmSync(join(folder.dir, '_pdf-upload'), { recursive: true });
        const set = loadLessonSet(folder.dir);
        expect(set.lessons[1]).toMatchObject({ pdf: null, pdfName: null, pdfSizes: [] });
        writeFileSync(join(folder.dir, '03-analisis-kebutuhan', 'default.pdf'), 'not a pdf');
        expect(() => loadLessonSet(folder.dir)).toThrow(/is not a PDF/);
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-1 refuses a folder with no index, a lesson the index lists and the folder lacks, or one that is no HTML document', () => {
      const folder = writeLessonFolder({ count: 2 });
      try {
        expect(() => loadLessonSet(join(folder.dir, '01-leads-generation-tactics'))).toThrow(/no index\.html/);
        writeFileSync(join(folder.dir, '02-media-sosial-leads-tracker', 'default.html'), 'Halo</head>');
        expect(() => loadLessonSet(folder.dir)).toThrow(/does not begin as an HTML document/);
        unlinkSync(join(folder.dir, '02-media-sosial-leads-tracker', 'default.html'));
        expect(() => loadLessonSet(folder.dir)).toThrow(/has no 02-media-sosial-leads-tracker\/default\.html/);
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-1 refuses a lesson file over the upload ceiling, as an upload of it would be', () => {
      const folder = writeLessonFolder({ count: 1 });
      try {
        const big = Buffer.alloc(ASSET_LIMITS.MAX_BYTES + 1, 0x20);
        big.write('%PDF-1.4\n', 0, 'latin1');
        writeFileSync(join(folder.dir, '01-leads-generation-tactics', 'default.pdf'), big);
        expect(() => loadLessonSet(folder.dir)).toThrow(/default\.pdf is over/);
      } finally {
        folder.remove();
      }
    });

    it('P19.6-T3 AC-1 compares titles by their letters and digits alone', () => {
      expect(titleKey('Media sosial &amp; leads tracker: dari konten')).toBe(titleKey('media sosial & Leads Tracker dari konten'));
      expect(titleKey('Leads generation')).not.toBe(titleKey('Leads generation: 8 cara'));
    });

    (delivered ? it : it.skip)('P19.6-T3 AC-1 the delivered folder: 23 lessons, each with its A4 PDF, each PDF recognisable by its size', () => {
      const set = loadLessonSet(DELIVERED);
      expect(set.lessons).toHaveLength(23);
      expect(set.lessons.every((lesson) => lesson.pdf !== null)).toBe(true);
      const sizes = set.lessons.map((lesson) => lesson.pdf!.length);
      expect(new Set(sizes).size).toBe(23);
      // `_pdf-upload/` holds the same PDFs, under production's upload names.
      expect(readdirSync(join(DELIVERED, '_pdf-upload')).filter((n) => n.endsWith('.pdf'))).toHaveLength(23);
      expect(set.lessons.every((lesson) => lesson.pdfSizes.length === 1)).toBe(true);
    });
  });
});
