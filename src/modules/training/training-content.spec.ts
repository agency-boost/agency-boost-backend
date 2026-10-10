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
 * **A module's content, checked whole** (P5-T2 AC-6; the Phase 18.5 exit review raised the training module's floor and
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
