import {
  SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEED_CAPABILITY_STAGES, SEEDED_CAPABILITY_LABELS_BEFORE_OD_238,
} from './capability';

/**
 * **The capability ladder a new office starts with, in Bahasa Indonesia** (P18.10-T7; OD-238, option 1; ADR-0179 §5).
 *
 * Pinned word for word: these are what a leader reads on Leader Notes and Capability Mapping. The four stages keep
 * their English names — the ladder's titles, as the role ladder's *Agency Builder* is (the approved glossary, §A.5) —
 * and so does the *Recruitment* grid (§A.6). The English recorded for migration 0046 is exactly what changed: every
 * code once, and never a word the seed kept.
 */
describe('P18.10-T7 the seeded capability ladder in Bahasa Indonesia (OD-238)', () => {
  const WAS = SEEDED_CAPABILITY_LABELS_BEFORE_OD_238;
  const items = SEED_CAPABILITY_GRIDS.flatMap((g) => g.items);

  it('keeps the four stages’ names, the ladder’s titles', () => {
    expect(SEED_CAPABILITY_STAGES.map((s) => s.label)).toEqual([
      'Competent Producer', 'Independent Producer', 'Productive Team Builder', 'Transformative Team Builder',
    ]);
  });

  it('writes the five milestones and the four grids in Bahasa Indonesia', () => {
    expect(SEED_CAPABILITY_MILESTONES.map((m) => m.label)).toEqual([
      'Menjual polis secara mandiri',
      'Menjual di luar jaringan langsung',
      'Merekrut agen berkualitas',
      'Membina agen downline hingga menjadi Independent Producer',
      'Membina leader downline hingga menjadi Productive Team Builder',
    ]);
    expect(SEED_CAPABILITY_GRIDS.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ['Penjualan pribadi', [
        'Konsistensi pencarian leads', 'Pendekatan & set appointment', 'Penggalian fakta & identifikasi kebutuhan',
        'Pengetahuan & saran produk', 'Presentasi', 'Penanganan keberatan & closing', 'Layanan purnajual',
      ]],
      ['Recruitment', [
        'Pencarian leads kandidat', 'Penyaringan calon kandidat', 'Pendekatan',
        'Pemetaan profil (motivasi / pemicu utama)', 'Pitch peluang bisnis', 'Closing recruitment & pendampingan FLC',
      ]],
      ['Membina agen downline', [
        'Visibilitas atas progres & goal setiap agen', 'Pemantauan aktivitas & check-in 1-on-1 yang konsisten',
        'Identifikasi kesenjangan keterampilan menjual agen', 'Memberikan coaching penjualan yang efektif kepada agen',
        'Memperkuat pola pikir & motivasi agen', '90-day activation yang terstruktur (termasuk Join Field Work)',
        'Mengaktifkan kembali agen yang tidak produktif',
      ]],
      ['Membina leader downline', [
        'Visibilitas atas progres setiap leader & timnya', 'Mengalokasikan waktu untuk membangun tim',
        'Identifikasi kesenjangan keterampilan recruitment leader downline',
        'Memberikan coaching recruitment yang efektif kepada leader', 'Mendampingi leader dalam Join Field Work recruitment',
        'Check-in 1-on-1 yang konsisten di seluruh tim leader',
        'Coaching the coach: meningkatkan efektivitas coaching para leader',
      ]],
    ]);
  });

  it('records the English of every word it changed, by a code the seed still has, and of nothing it kept', () => {
    expect(Object.keys(WAS.milestones)).toEqual(SEED_CAPABILITY_MILESTONES.map((m) => m.code));
    expect(Object.keys(WAS.grids)).toEqual(SEED_CAPABILITY_GRIDS.filter((g) => g.code !== 'RECRUITMENT').map((g) => g.code));
    expect(Object.keys(WAS.items)).toEqual(items.map((i) => i.code));
    for (const m of SEED_CAPABILITY_MILESTONES) expect(WAS.milestones[m.code]).not.toBe(m.label);
    for (const i of items) expect(WAS.items[i.code]).not.toBe(i.label);
    expect(WAS.grids.PERSONAL_SELLING).toBe('Personal selling');
  });
});
