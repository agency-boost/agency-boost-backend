import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **A lesson folder shaped as the owner delivered it** (P19.6-T3; `revisions/2026-11-03/files/training-modules/`),
 * written to a temporary directory: `index.html` with the delivered numbers, folders, titles and headings, one folder
 * per lesson with a small `default.html` — `:root` colours, anchors, the lesson's own scroll script — and a
 * `default.pdf`, and `_pdf-upload/` with the same PDFs under the names production's were uploaded with.
 *
 * The specs run on this, never on the superproject's folder, which a CI checkout of the backend alone does not have.
 * Each PDF has its own size, `pdfSize(n)`, as the delivered ones do.
 */
export const DELIVERED_LESSONS: readonly { folder: string; title: string; category: string }[] = [
  { folder: '01-leads-generation-tactics', title: 'Leads generation: 8 cara mendapat calon nasabah', category: 'Sales' },
  { folder: '02-media-sosial-leads-tracker', title: 'Media sosial & leads tracker: dari konten ke janji temu', category: 'Sales' },
  { folder: '03-analisis-kebutuhan', title: 'Fact finding: menghitung kebutuhan perlindungan nasabah', category: 'Sales' },
  { folder: '04-handling-objections-closing', title: 'Handling objections: menjawab keberatan lalu closing', category: 'Sales' },
  { folder: '05-cross-sell-retensi', title: 'Cross-sell: menambah perlindungan dan mempertahankan nasabah', category: 'Sales' },
  { folder: '06-asuransi-jiwa', title: 'Asuransi jiwa: memilih dan menjelaskan jenisnya', category: 'Produk' },
  { folder: '07-asuransi-kesehatan', title: 'Asuransi kesehatan: memilih perlindungan biaya rumah sakit', category: 'Produk' },
  { folder: '08-critical-illness', title: 'Critical Illness: uang tunai saat sakit kritis', category: 'Produk' },
  { folder: '09-asuransi-pendidikan', title: 'Asuransi pendidikan: menghitung dan melindungi dana sekolah anak', category: 'Produk' },
  { folder: '10-unit-link', title: 'Unit link: menjelaskan proteksi plus investasi', category: 'Produk' },
  { folder: '11-why-recruit-sumber-kandidat', title: 'Mengapa membangun tim & Lead Generation: mencari kandidat', category: 'Recruitment' },
  { folder: '12-filtering-approaching-profiling', title: 'Filtering, Approaching & Profiling: memilih dan memahami kandidat', category: 'Recruitment' },
  { folder: '13-pitching-handling-objections-kandidat', title: 'Pitching dengan HESA: meyakinkan kandidat bergabung', category: 'Recruitment' },
  { folder: '14-follow-up-program-rekrutmen', title: 'Follow up kandidat: dari ragu sampai mulai bergabung', category: 'Recruitment' },
  { folder: '15-peran-leader-membangun-tim', title: 'Peran leader: membangun, membina & menghitung target tim', category: 'Manajemen tim' },
  { folder: '16-1on1-checkin-goal-setting', title: '1-on-1 check-in, goal-setting & tracking: membina agen tiap minggu', category: 'Manajemen tim' },
  { folder: '17-new-agent-activation', title: 'New agent activation: bimbing agen baru 90 hari pertama', category: 'Manajemen tim' },
  { folder: '18-team-meeting-strategic-forum', title: 'Team meeting & forum check-in: rapat tim yang efektif', category: 'Manajemen tim' },
  { folder: '19-building-trust-situational-leadership', title: 'Building Trust & Situational Leadership: pimpin sesuai tahap agen', category: 'Soft skills' },
  { folder: '20-coaching-grow-5-whys', title: 'Coaching dengan GROW & 5 Whys: temukan akar masalah', category: 'Soft skills' },
  { folder: '21-menghadapi-penolakan', title: 'Menghadapi penolakan: tetap semangat setelah ditolak', category: 'Motivasi' },
  { folder: '22-kebiasaan-pola-pikir', title: 'Kebiasaan & mindset: bangun rutinitas kerja yang konsisten', category: 'Motivasi' },
  { folder: '23-sistem-agency-tata-kelola', title: 'Sistem agency & tata kelola: bagi peran dan pekerjaan dengan jelas', category: 'Perusahaan dan agency' },
];

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Lesson n's PDF size: distinct for every lesson, as the delivered PDFs' are. */
export const pdfSize = (n: number) => 1000 + n * 37;

/** A lesson's `default.html`, as the owner's are shaped: colours on `:root`, anchors, one scroll script. */
export function lessonHtml(title: string, marker = ''): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>:root { --ink: #1c2340; --accent: #d9822b; --accent-soft: #fdf1e4; --green: #2f7d4f; --red: #c2410c; }</style>
</head>
<body>
<main><h1>${escape(title)}</h1><a href="#bagian-2">Bagian 2</a><section id="bagian-2">${marker}</section></main>
<script>document.addEventListener("click",function(e){var a=e.target.closest("a[href^=\\"#\\"]");if(!a)return;var el=document.getElementById(a.getAttribute("href").slice(1));if(el){e.preventDefault();el.scrollIntoView({behavior:"smooth",block:"start"});}});</script>
</body>
</html>
`;
}

export function lessonPdf(n: number): Buffer {
  const body = Buffer.alloc(pdfSize(n), 0x20);
  body.write('%PDF-1.4\n', 0, 'latin1');
  return body;
}

export interface LessonFolder {
  dir: string;
  remove: () => void;
}

/**
 * Write the folder. `count` lessons from the start of the delivered list (all 23 by default); `withoutPdf` the numbers
 * with no `default.pdf`; `marker` changes every lesson's text, as a refreshed delivery would.
 */
export function writeLessonFolder(options: { count?: number; withoutPdf?: number[]; marker?: string } = {}): LessonFolder {
  const dir = mkdtempSync(join(tmpdir(), 'ab-lessons-'));
  const lessons = DELIVERED_LESSONS.slice(0, options.count ?? DELIVERED_LESSONS.length);
  const headings: string[] = [];
  let index = '<!doctype html>\n<html lang="id"><head><meta charset="utf-8"><title>Modul training</title></head><body><main>\n';
  for (const [i, lesson] of lessons.entries()) {
    const n = i + 1;
    if (headings.at(-1) !== lesson.category) {
      if (headings.length) index += '  </div>\n';
      headings.push(lesson.category);
      index += `  <h2>${escape(lesson.category)}</h2>\n  <div class="list">\n`;
    }
    index += `    <a href="${lesson.folder}/default.html"><span class="num">${String(n).padStart(2, '0')}</span>`
      + `<span class="ttl">${escape(lesson.title)}</span><span class="cnt">5 bagian</span></a>\n`;
    mkdirSync(join(dir, lesson.folder));
    writeFileSync(join(dir, lesson.folder, 'default.html'), lessonHtml(lesson.title, options.marker));
    if (!options.withoutPdf?.includes(n)) {
      writeFileSync(join(dir, lesson.folder, 'default.pdf'), lessonPdf(n));
    }
  }
  index += '  </div>\n</main></body></html>\n';
  writeFileSync(join(dir, 'index.html'), index);
  mkdirSync(join(dir, '_pdf-upload'));
  for (const [i, lesson] of lessons.entries()) {
    const n = i + 1;
    writeFileSync(join(dir, '_pdf-upload', `${String(n).padStart(2, '0')} ${lesson.title.replace(':', ' -')}.pdf`), lessonPdf(n));
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
