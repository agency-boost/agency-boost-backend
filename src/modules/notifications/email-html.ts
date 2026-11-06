/**
 * **The HTML alternative of an email, derived from its text** (P18.11-T18, ADR-0182).
 *
 * The text stays the one source of every word (`email-renderer.ts`): this only presents it. A message sent as text
 * alone scores worse with spam filters than one carrying both parts, and some clients show a bare URL in plain text as
 * something nobody can tap. So every email is `multipart/alternative`: the same words, the text first and this second.
 *
 * Escaped first, then shaped: every `&`, `<`, `>`, `"` and `'` is an entity before any markup is added, so a name or a
 * title somebody typed can never become a tag. A blank line starts a paragraph, a single newline is a `<br>`, and an
 * `http(s)` URL is an anchor to itself, its text the URL, so the reader sees where it goes. Minimal inline style, no
 * images and nothing that tracks an open.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Every character that could open markup or close an attribute, as its entity. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

/** An `http` or `https` URL, up to whitespace or a character that cannot be in one unencoded. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
/** Punctuation that ends a sentence rather than the URL before it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

const PARAGRAPH = 'margin:0 0 16px 0';
// No colour: every client draws a link in its own, and a raw value here would be one more to keep in step.
const LINK = 'word-break:break-all';
const BODY = 'margin:0;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5';

/** One line, escaped, with each URL in it an anchor. */
function linkify(line: string): string {
  let html = '';
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    const start = match.index;
    html += escapeHtml(line.slice(last, start));
    html += `<a href="${escapeHtml(url)}" style="${LINK}">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return html + escapeHtml(line.slice(last));
}

/** The message's text as a small HTML document: paragraphs, line breaks and links, nothing else. */
export function toHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\n+$/g, ''))
    .filter((block) => block.trim() !== '')
    .map((block) => `<p style="${PARAGRAPH}">${block.split('\n').map(linkify).join('<br>\n')}</p>`);
  return '<!doctype html>\n<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"></head>\n'
    + `<body style="${BODY}"><div style="max-width:560px">\n${paragraphs.join('\n')}\n</div></body></html>\n`;
}
