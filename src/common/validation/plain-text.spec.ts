import { plainText, plainTextLines } from './plain-text';

/**
 * Authored text, with markup out (P5-T4 AC-7, P5-T10 AC-6) — on one line, or keeping the lines as typed
 * (P19-T6 AC-1, the 11-03 handover's B1-2).
 */
describe('plainText — one line', () => {
  it('takes out every tag, and a script or a style with its contents', () => {
    expect(plainText('<b>Halo</b> <script>alert(1)</script>Bapak<style>p{}</style>')).toBe('Halo Bapak');
  });

  it('makes every run of whitespace one space, a line break included — a name stays one line', () => {
    expect(plainText('  PRU\r\nMapan \t Syariah\n\n')).toBe('PRU Mapan Syariah');
  });

  it('answers an empty string for nothing', () => {
    expect(plainText(undefined)).toBe('');
    expect(plainText(null)).toBe('');
  });
});

describe('plainTextLines — the lines as typed (P19-T6 AC-1)', () => {
  it('P19-T6 AC-1 keeps every line break the author typed', () => {
    const typed = '1. "Mahal" → Mulai dari Rp 300 rb\n2. "Nanti saja" → Risiko tidak menunggu';
    expect(plainTextLines(typed)).toBe(typed);
  });

  it('P19-T6 AC-1 writes every line ending as LF: CRLF, a lone CR and the Unicode separators', () => {
    expect(plainTextLines('a\r\nb\rc\u2028d\u2029e')).toBe('a\nb\nc\nd\ne');
  });

  it('P19-T6 AC-1 trims each line and makes a run of spaces or tabs inside it one space', () => {
    expect(plainTextLines('  Halo   Bapak \t\n\tIbu  ')).toBe('Halo Bapak\nIbu');
  });

  it('P19-T6 AC-1 keeps one blank line between paragraphs and no more', () => {
    expect(plainTextLines('Pembuka\n\nIsi')).toBe('Pembuka\n\nIsi');
    expect(plainTextLines('Pembuka\n\n\n\n\nIsi')).toBe('Pembuka\n\nIsi');
    // A line of spaces is a blank line once it is trimmed, and counts as one.
    expect(plainTextLines('Pembuka\n   \n \t \nIsi')).toBe('Pembuka\n\nIsi');
  });

  it('P19-T6 AC-1 drops blank lines at the start and the end', () => {
    expect(plainTextLines('\n\n  Halo\n\n')).toBe('Halo');
  });

  it('P19-T6 AC-1 keeps the no-markup guarantee: tags out, a script and a style with their contents', () => {
    expect(plainTextLines('<b>Halo</b>\n<script>alert(1)</script>Bapak\n<i\n>Ibu</i><style>p{}</style>'))
      .toBe('Halo\nBapak\nIbu');
  });

  it('P19-T6 AC-1 reads a pasted <br> as the line break it meant', () => {
    expect(plainTextLines('Satu<br>Dua<br/>Tiga<BR />Empat')).toBe('Satu\nDua\nTiga\nEmpat');
  });

  it('answers an empty string for nothing, and for a field of blank lines', () => {
    expect(plainTextLines(undefined)).toBe('');
    expect(plainTextLines(' \n\r\n \t ')).toBe('');
  });
});
