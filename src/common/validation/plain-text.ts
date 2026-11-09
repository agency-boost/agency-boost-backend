/** A `<script>` or `<style>` element, contents and all. */
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Any other tag, opening or closing. A line break inside a tag is inside the tag. */
const TAG = /<\/?[a-z][^>]*>/gi;

/**
 * Authored text, with markup taken out (P5-T4 AC-7, P5-T10 AC-6).
 *
 * **Nothing authored reaches a screen as markup.** The prototype encodes a script's structure in
 * `<b>` tags and renders it through `innerHTML`, so the formatting *is* the data and anybody who
 * can write a script can write a tag. Both halves are stripped here — the company's default and
 * the office's override — because a rule enforced on one side only is a rule with a way around it.
 *
 * **`<script>` and `<style>` lose their contents too, not just their tags.** Stripping the tags
 * alone is safe — the leftover is text, and text renders as text — but it leaves `alert(1)` sitting
 * in the middle of a sales script, which reads as a bug to whoever finds it. Nothing inside either
 * element was ever prose somebody meant to keep.
 *
 * **One line**: every run of whitespace, a line break included, becomes one space. For a field
 * typed into a one-line input — a name, a tagline, one benefit. A field written in paragraphs is
 * {@link plainTextLines}.
 */
export const plainText = (value: unknown): string => String(value ?? '')
  .replace(SCRIPT_OR_STYLE, ' ')
  .replace(TAG, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * **Authored text that keeps its line breaks** (P19-T6 AC-1, the handover's B1-2): the same markup
 * rule as {@link plainText} — `<script>` and `<style>` with their contents, every other tag — and
 * then the lines as the author typed them, tidied the way nobody would notice:
 *
 * - every line ending is `\n` — `\r\n` from Windows, a lone `\r`, and the Unicode line and paragraph
 *   separators alike; a `<br>` pasted in is a line break too, since that is what it meant;
 * - inside each line, a run of spaces or tabs is one space, and the line is trimmed at both ends —
 *   what `white-space: pre-line` draws anyway, so the stored text is the text shown;
 * - **at most one blank line** between two paragraphs: three or more line breaks in a row are two;
 * - blank lines at the start and the end go.
 *
 * Collapsing every line break into a space, as {@link plainText} does, is what flattened a
 * product's objection answers — *1. "…" → …* typed on its own line, saved as one paragraph — on
 * production (2026-11-03). For a field typed into a textarea: an attack plan's script fields, and
 * what sets a product apart. Still plain text: nothing here is markup, and every screen draws it as
 * text.
 */
export const plainTextLines = (value: unknown): string => String(value ?? '')
  .replace(SCRIPT_OR_STYLE, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(TAG, '')
  .replace(/\r\n?|[\u2028\u2029]/g, '\n')
  .split('\n')
  .map((line) => line.replace(/\s+/g, ' ').trim())
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
