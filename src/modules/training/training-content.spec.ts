import type { DomainException } from '@/common/errors/domain.exception';
import { readerIn } from '@/common/i18n/reader';
import { checkTrainingContent, CONTENT_BOUNDS, emptyContent, storageKeysOf } from './training-content';

/** The refusal's violations, or `[]` when the body passes. */
function violations(body: unknown): string[] {
  try {
    checkTrainingContent(body);
    return [];
  } catch (err) {
    return ((err as { getResponse?: () => { details?: { violations?: string[] } } }).getResponse?.()?.details?.violations) ?? [String(err)];
  }
}

const file = (over: Record<string, unknown> = {}) => ({
  label: 'Deck.pdf', storageKey: 'dev/a/training/1', mimeType: 'application/pdf', bytes: 1024, ...over,
});
const link = (over: Record<string, unknown> = {}) => ({ label: 'Talk', url: 'https://learn.example.com/talk', ...over });

/**
 * **A module's content, checked whole** (P5-T2 AC-6; the Phase 18.2 exit review raised the training module's floor and
 * this file was its gap): every rule the checker enforces, one violation per bad row, all of them at once.
 */
describe('checkTrainingContent', () => {
  it('reads an empty body as empty content, and lists keys file by file', () => {
    expect(checkTrainingContent(undefined)).toEqual(emptyContent());
    expect(checkTrainingContent(null)).toEqual(emptyContent());
    const checked = checkTrainingContent({ files: [file()], videos: [file({ storageKey: 'dev/a/training/2', mimeType: 'video/mp4' })], links: [link()] });
    expect(storageKeysOf(checked)).toEqual(['dev/a/training/1', 'dev/a/training/2']);
    expect(checked.links[0].url).toBe('https://learn.example.com/talk');
  });

  it('mints an id for a new item, keeps one it is given, and counts bytes it is not given as 0', () => {
    const checked = checkTrainingContent({ files: [file({ id: '  01KEEP  ' }), file({ storageKey: 'k2', bytes: undefined })], links: [link()] });
    expect(checked.files[0].id).toBe('01KEEP');
    expect(checked.files[1].id).toMatch(/^[0-9A-Z]{26}$/);
    expect(checked.files[1].bytes).toBe(0);
    expect(checked.links[0].id).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('refuses a field it does not know, at either level', () => {
    expect(violations({ files: [], extra: true }).join(' ')).toContain('extra');
    expect(violations({ files: [file({ colour: 'red' })] }).join(' ')).toContain('colour');
  });

  it('refuses a section that is not a list, and one over the bound', () => {
    expect(violations({ files: 'deck.pdf' })).toContain('files must be a list.');
    const many = Array.from({ length: CONTENT_BOUNDS.perSection + 1 }, (_, i) => link({ id: `L${i}` }));
    expect(violations({ links: many })).toContain(`A module holds at most ${CONTENT_BOUNDS.perSection} links; this one has ${many.length}.`);
  });

  it('refuses a row that is not an object, a file or a link alike', () => {
    expect(violations({ files: [null] })).toContain('File 1 must be an object of fields.');
    expect(violations({ videos: [[]] })).toContain('Video 1 must be an object of fields.');
    expect(violations({ links: ['https://x.test'] })).toContain('Link 1 must be an object of fields.');
  });

  it('refuses a file missing what makes it deliverable, naming the row', () => {
    const found = violations({ files: [file({ label: '' }), file({ storageKey: undefined }), file({ mimeType: undefined })] });
    expect(found.some((v) => v.startsWith('File 1:'))).toBe(true);
    expect(found.some((v) => v.startsWith('File 2:'))).toBe(true);
    expect(found.some((v) => v.startsWith('File 3:'))).toBe(true);
  });

  it('refuses a link with no address, one that is not an address, and one that is not https', () => {
    expect(violations({ links: [link({ url: '' })] })).toContain('Link 1: url is required.');
    expect(violations({ links: [link({ url: 'not a url' })] })).toContain('Link 1: "not a url" is not a web address.');
    expect(violations({ links: [link({ url: 'http://learn.example.com' })] }).join(' ')).toContain('must start with https://');
    expect(violations({ links: [link({ label: '' })] }).some((v) => v.startsWith('Link 1:'))).toBe(true);
  });

  it('refuses two items sharing an id, across sections', () => {
    expect(violations({ files: [file({ id: 'SAME' })], links: [link({ id: 'SAME' })] })).toContain('Two items in this module share an id.');
  });

  it('collects every violation before refusing', () => {
    expect(violations({ files: [null], links: [link({ url: 'http://x.test' })] })).toHaveLength(2);
  });
});

/**
 * **A module's content refused in Bahasa Indonesia** (P18.10-T5 AC-3): each item named by its place in the reader's
 * words — *File 1*, *Video 1*, *Tautan 1* — its own field's sentence after it, the English unchanged.
 */
describe('P18.10-T5 AC-3 checkTrainingContent, in both languages', () => {
  const refused = (body: unknown): DomainException => {
    try {
      checkTrainingContent(body);
    } catch (err) {
      return err as DomainException;
    }
    throw new Error('expected a refusal');
  };
  const indonesian = (body: unknown) => (refused(body).detailsFor(readerIn('id')) as { violations: string[] }).violations;

  it('P18.10-T5 AC-3 every rule, its item named in Indonesian', () => {
    expect(indonesian({ files: 'deck.pdf', videos: [[]], links: [link({ url: '' }), link({ url: 'not a url' }), link({ url: 'http://x.test' })] }))
      .toEqual([
        'files harus berupa daftar.',
        'Video 1 harus berupa objek berisi kolom.',
        'Tautan 1: url wajib diisi.',
        'Tautan 2: "not a url" bukan alamat web.',
        'Tautan 3: tautan harus diawali https://. "http://x.test" akan diblokir atau diberi peringatan di ponsel agent.',
      ]);
    expect(indonesian({ files: [file({ label: '' })], links: [link({ label: '', id: 'SAME' })], videos: [file({ id: 'SAME', storageKey: 'k2' })] }))
      .toEqual([
        'File 1: label harus 1–200 karakter.',
        'Tautan 1: label harus 1–200 karakter.',
        'Dua item di modul ini memakai ID yang sama.',
      ]);
    const many = Array.from({ length: CONTENT_BOUNDS.perSection + 1 }, () => link());
    expect(indonesian({ links: many })).toEqual([`Satu modul paling banyak berisi ${CONTENT_BOUNDS.perSection} links; modul ini berisi ${many.length}.`]);
    expect(indonesian({ files: [null] })).toEqual(['File 1 harus berupa objek berisi kolom.']);
    expect(indonesian({ links: [{ label: 'Talk' }] })).toEqual(['Tautan 1: url wajib diisi.']);
  });

  it('P18.10-T5 AC-3 the English and the message are as they were: the sentences joined by "; "', () => {
    const err = refused({ links: [link({ url: 'http://x.test' })], files: [null] });
    expect(err.message).toBe('File 1 must be an object of fields.; Link 1: a link must start with https://. "http://x.test" would be '
      + 'blocked or warned about on an agent’s phone.');
    expect(err.messageFor(readerIn('id'))).toBe('File 1 harus berupa objek berisi kolom.; Tautan 1: tautan harus diawali https://. '
      + '"http://x.test" akan diblokir atau diberi peringatan di ponsel agent.');
  });
});
