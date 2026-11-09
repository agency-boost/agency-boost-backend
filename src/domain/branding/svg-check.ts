/**
 * **An uploaded SVG is checked, never rewritten** (P19.6-T1 AC-3; ADR-0218 §2). It is refused when it holds a script,
 * any `on…` attribute, a `<foreignObject>`, a `<!DOCTYPE` or `<!ENTITY`, an `href` or `xlink:href` that does not start
 * with `#`, or a `url(…)` or `@import` that does not point inside the file. One that passes is rendered to PNG on the
 * server and the SVG itself is never served, so no browser draws a file a member uploaded as SVG.
 */
const REFUSED: readonly RegExp[] = [
  /<\s*script\b/i,
  /<\s*foreignObject\b/i,
  /<!\s*DOCTYPE\b/i,
  /<!\s*ENTITY\b/i,
  // Any event handler, on any element: ` onload=`, `\nonclick =`.
  /[\s"'/]on[a-z]+\s*=/i,
  // An outside reference: an href whose value does not begin with `#`.
  /\b(?:xlink:)?href\s*=\s*(?:"(?!#)|'(?!#)|(?!["'#]))/i,
  // `url(…)` not pointing inside the file: `url(#a)` and `url('#a')` pass.
  /url\(\s*(?!["']?#)/i,
  /@import\b/i,
];

/** Whether the bytes are an SVG this product may render: an `<svg` element, and nothing above. */
export function isSafeSvg(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) return false;
  return !REFUSED.some((rule) => rule.test(text));
}
