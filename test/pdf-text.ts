import { inflateSync } from 'node:zlib';

/**
 * **A PDF read back, as a phone's viewer would read it** (P19.7-T3 AC-8): the pages it holds, and on each page the text
 * it draws — each fragment with its font size and its fill colour — decoded through each font's `ToUnicode` map.
 *
 * Written for the files `pdfkit` (under `pdfmake`) makes: indirect objects, Flate streams, Type0 fonts with
 * `Identity-H` and a `bfrange` map, text drawn as `[<hex> kern <hex>] TJ` after `Tf`, `Tm` and `rg`. It is a test's
 * reader, not a general one: a file it cannot read fails the test rather than passing it.
 */
export interface PdfFragment {
  text: string;
  size: number;
  colour: string;
  /** The embedded font's name, its subset tag taken off: `Inter-Regular`. */
  font: string;
  /** Where it starts and ends across the page, and its baseline, in points. */
  x: number;
  end: number;
  y: number;
}
export interface PdfPage { fragments: PdfFragment[]; text: string; width: number }
export interface ReadPdf { pages: PdfPage[]; info: Record<string, string>; header: string }

interface PdfFont { name: string; unicode: Map<number, string>; widths: Map<number, number> }

interface PdfObject { dict: string; stream: Buffer | null }

function objectsOf(bytes: Buffer): Map<number, PdfObject> {
  const text = bytes.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+) 0 obj\s*([\s\S]*?)endobj/g;
  for (const match of text.matchAll(pattern)) {
    const body = match[2];
    const at = body.indexOf('stream');
    if (at < 0 || !/^stream\r?\n/.test(body.slice(at))) {
      objects.set(Number(match[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, at);
    const start = match.index! + match[0].indexOf(body) + at + body.slice(at).indexOf('\n') + 1;
    const end = text.indexOf('endstream', start);
    let raw = bytes.subarray(start, end);
    if (raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
    const stream = /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw;
    objects.set(Number(match[1]), { dict, stream });
  }
  return objects;
}

const ref = (dict: string, key: string): number | null => {
  const match = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(dict);
  return match ? Number(match[1]) : null;
};

/** A `ToUnicode` map: code → text. */
function cmapOf(source: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexText = (hex: string) => String.fromCharCode(...hex.trim().split(/\s+/).map((h) => parseInt(h, 16)));
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F ]+>)/g)) {
      const [from, to] = [parseInt(line[1], 16), parseInt(line[2], 16)];
      if (line[3].startsWith('[')) {
        const entries = [...line[3].matchAll(/<([0-9a-fA-F ]+)>/g)].map((m) => m[1]);
        entries.forEach((hex, i) => map.set(from + i, hexText(hex.replace(/(.{4})/g, '$1 '))));
      } else {
        const base = parseInt(line[3].slice(1, -1), 16);
        for (let code = from; code <= to; code += 1) map.set(code, String.fromCharCode(base + code - from));
      }
    }
  }
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const line of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(line[1], 16), hexText(line[2].replace(/(.{4})/g, '$1 ')));
    }
  }
  return map;
}

const hex2 = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();

/** Read a PDF's pages and their text. */
export function readPdf(bytes: Buffer): ReadPdf {
  const objects = objectsOf(bytes);
  const fontMaps = new Map<number, PdfFont>();
  const fontFor = (fontRef: number): PdfFont => {
    if (!fontMaps.has(fontRef)) {
      const font = objects.get(fontRef)!;
      const unicode = ref(font.dict, 'ToUnicode');
      const descendant = Number(/\/DescendantFonts\s*\[\s*(\d+) 0 R/.exec(font.dict)?.[1]);
      const cid = objects.get(descendant)?.dict ?? '';
      // `/W [0 [w0 w1 …]]`, glyph widths in thousandths of the size, from code 0.
      const widths = new Map<number, number>();
      const w = /\/W\s*\[\s*(\d+)\s*\[([^\]]*)\]/.exec(cid);
      if (w) w[2].trim().split(/\s+/).forEach((value, i) => widths.set(Number(w[1]) + i, Number(value)));
      fontMaps.set(fontRef, {
        name: (/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/.exec(font.dict)?.[1]) ?? '',
        unicode: unicode ? cmapOf(objects.get(unicode)!.stream!.toString('latin1')) : new Map(),
        widths,
      });
    }
    return fontMaps.get(fontRef)!;
  };

  // The page tree's order: the Pages object's Kids.
  const root = [...objects.values()].find((o) => /\/Type\s*\/Pages\b/.test(o.dict))!;
  const kids = [...(/\/Kids\s*\[([^\]]*)\]/.exec(root.dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));

  const pages = kids.map((id) => {
    const page = objects.get(id)!;
    const resourcesId = ref(page.dict, 'Resources');
    const resources = resourcesId ? objects.get(resourcesId)!.dict : page.dict;
    const fonts = new Map<string, number>();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? '';
    for (const m of fontDict.matchAll(/\/(\w+)\s+(\d+) 0 R/g)) fonts.set(m[1], Number(m[2]));
    const contentIds = [...(/\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
    const content = contentIds.map((cid) => objects.get(cid)!.stream!.toString('latin1')).join('\n');

    const fragments: PdfFragment[] = [];
    let font: PdfFont = { name: '', unicode: new Map(), widths: new Map() };
    let size = 0;
    let colour = '#000000';
    let x = 0;
    let y = 0;
    const tokens = content.matchAll(
      /\/(\w+)\s+([\d.]+)\s+Tf|([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|scn)\b|1 0 0 1 ([-\d.]+) ([-\d.]+) Tm|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g,
    );
    for (const t of tokens) {
      if (t[1]) {
        font = fontFor(fonts.get(t[1])!);
        size = Number(t[2]);
      } else if (t[3]) {
        colour = `#${hex2(Number(t[3]))}${hex2(Number(t[4]))}${hex2(Number(t[5]))}`;
      } else if (t[6]) {
        x = Number(t[6]);
        y = Number(t[7]);
      } else if (t[8] !== undefined) {
        let text = '';
        let advance = 0;
        // A run alternates glyph strings and adjustments: thousandths of the size, a positive one moving left.
        for (const part of t[8].matchAll(/<([0-9a-fA-F]*)>|(-?[\d.]+)/g)) {
          if (part[2] !== undefined) {
            advance -= Number(part[2]);
            continue;
          }
          for (let i = 0; i < part[1].length; i += 4) {
            const code = parseInt(part[1].slice(i, i + 4), 16);
            text += font.unicode.get(code) ?? '\uFFFD';
            advance += font.widths.get(code) ?? 0;
          }
        }
        fragments.push({ text, size, colour, font: font.name, x, end: x + (advance / 1000) * size, y });
      }
    }
    // Lines: fragments on one baseline joined, top to bottom as drawn; a gap between two that do not touch is a space.
    const lines: string[] = [];
    let last: PdfFragment | null = null;
    for (const f of fragments) {
      if (last && Math.abs(f.y - last.y) < 0.5) {
        const apart = f.x > last.end + 1 && !/\s$/.test(lines[lines.length - 1]) && !/^\s/.test(f.text);
        lines[lines.length - 1] += (apart ? ' ' : '') + f.text;
      } else {
        lines.push(f.text);
      }
      last = f;
    }
    const box = /\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)/.exec(page.dict);
    return {
      fragments,
      text: lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'),
      width: box ? Number(box[1]) : 0,
    };
  });

  const info: Record<string, string> = {};
  const trailerInfo = /\/Info\s+(\d+) 0 R/.exec(bytes.toString('latin1'));
  if (trailerInfo) {
    const dict = objects.get(Number(trailerInfo[1]))!.dict;
    for (const m of dict.matchAll(/\/(\w+)\s*(<[0-9a-fA-F]*>|\((?:[^()\\]|\\.)*\)|\d+ 0 R)/g)) {
      const raw = / 0 R$/.test(m[2]) ? objects.get(parseInt(m[2], 10))!.dict.trim() : m[2];
      info[m[1]] = raw.startsWith('<')
        ? decodeUtf16Hex(raw.slice(1, -1))
        : raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return { pages, info, header: bytes.subarray(0, 8).toString('latin1') };
}

function decodeUtf16Hex(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('latin1');
}

/** WCAG's contrast of a `#RRGGBB` colour on white. */
export function contrastOnWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (l + 0.05);
}
