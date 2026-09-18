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
 */
export const plainText = (value: unknown): string => String(value ?? '')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<\/?[a-z][^>]*>/gi, '')
  .replace(/\s+/g, ' ')
  .trim();
