/**
 * **The owner's lessons in the template's modules, and the colours a lesson reads** (P19.6-T3; ADR-0217 §5; the
 * 11-03 handover's §B6 *Then upload the HTML* and *Lesson pages should use the KPM colours*).
 *
 * - **Where a company's copies live**: `<prefix>/company/<companyId>/training/lessons/<folder>-<hash>.<html|pdf>`, a
 *   company asset (ADR-0032) the template's modules reference. The name carries the first `HASH_DIGITS` hexadecimal
 *   digits of the served copy's SHA-256, so a refreshed lesson is a new file and a published version's files never
 *   change.
 * - **The fragment's names** (`#accent=…&accentSoft=…&ink=…`) and the CSS variable each sets on the lesson's `:root`.
 *   The values are the API's (`lessonColoursOf`, `domain/branding/palette.ts`), each six lower-case hexadecimal
 *   digits. The served copy's reader applies them and decides nothing; the lesson's status colours (`--green`,
 *   `--red`, `--blue`) are never among them. The frontend's `lessonFragment` (`frontend/src/lib/html-document.ts`)
 *   writes the same three names.
 */
export const LESSONS = {
  FOLDER: 'training/lessons',
  HASH_DIGITS: 12,
} as const;

/** ADR-0217 §5: a fragment name, and the lesson's own variable it sets. */
export const LESSON_COLOUR_VARIABLES = {
  accent: '--accent',
  accentSoft: '--accent-soft',
  ink: '--ink',
} as const;
export type LessonColourName = keyof typeof LESSON_COLOUR_VARIABLES;

/** ADR-0217 §5: the only value a lesson accepts, six lower-case hexadecimal digits with no `#`. */
export const LESSON_COLOUR_VALUE = /^[0-9a-f]{6}$/;
