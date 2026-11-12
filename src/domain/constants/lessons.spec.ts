import { derivePalette, lessonColoursOf } from '@/domain/branding/palette';
import { LESSON_COLOUR_VALUE, LESSON_COLOUR_VARIABLES, LESSONS } from './index';

/** P19.6-T3 (ADR-0217 §5; §B.9): the lessons' folder, and the three colour names a lesson reads. */
describe('the lessons’ constants (P19.6-T3)', () => {
  it('P19.6-T3 AC-1 pins where a company’s lessons are stored, and how much of the hash names a file', () => {
    expect(LESSONS).toEqual({ FOLDER: 'training/lessons', HASH_DIGITS: 12 });
  });

  it('P19.6-T3 AC-5 pins the fragment’s three names onto the lesson’s own variables, and no status colour', () => {
    expect(LESSON_COLOUR_VARIABLES).toEqual({ accent: '--accent', accentSoft: '--accent-soft', ink: '--ink' });
    expect(Object.values(LESSON_COLOUR_VARIABLES)).not.toEqual(expect.arrayContaining(['--green']));
    expect(LESSON_COLOUR_VALUE.source).toBe('^[0-9a-f]{6}$');
  });

  it('P19.6-T3 AC-5 names exactly what the API’s palette gives a lesson, each value one the reader accepts', () => {
    const derived = derivePalette('#0e7c66', '#1f2a44');
    const colours = lessonColoursOf(derived.palette)!;
    expect(Object.keys(colours).sort()).toEqual(Object.keys(LESSON_COLOUR_VARIABLES).sort());
    for (const [name, value] of Object.entries(colours)) {
      expect(Object.keys(LESSON_COLOUR_VARIABLES)).toContain(name);
      expect(value).toMatch(LESSON_COLOUR_VALUE);
    }
  });
});
