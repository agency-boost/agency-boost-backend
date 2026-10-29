import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_PATTERN } from '@/common/validation/fields';
import {
  SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS, SEEDED_TRAINING_WORDINGS_BEFORE_OD_238,
} from './training-taxonomy';

/**
 * **The seed in the prototype's English** (P18.98-T7, OD-238): the words it gave before it was written in Bahasa
 * Indonesia, where it changed one, and its own where it kept one English. What the prototype is compared against.
 */
const WAS = SEEDED_TRAINING_WORDINGS_BEFORE_OD_238;
const englishCategory = (c: { code: string; label: string }) => WAS.categories[c.code]?.label ?? c.label;
const englishSkill = (s: { code: string; label: string }) => WAS.skills[s.code] ?? s.label;
const englishModule = (m: { code: string; title: string }) => WAS.modules[m.code] ?? m.title;

/**
 * The seeded training taxonomy against the screen it was transcribed from (P5-T1, ADR-0029).
 *
 * Read out of `KPM_Owner.html` rather than restated: a test carrying its own copy of the
 * labels would be a third transcription, agreeing with the seed whether or not either matched
 * the prototype — the lesson `activity-taxonomy.spec.ts` records.
 */
const PROTOTYPE = join(__dirname, '../../../../prototype/AgencyBoost_KPM_Owner.html');

function prototype() {
  const html = readFileSync(PROTOTYPE, 'utf8');
  const categories = [
    ...(/const CATEGORY_LIST = \[([^\]]*)\]/.exec(html)?.[1] ?? '').matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  const skills = [
    ...(/const SKILLS_BY_CATEGORY = \{[\s\S]*?'Sales': \[([\s\S]*?)\]/.exec(html)?.[1] ?? '')
      .matchAll(/name:'([^']+)'/g),
  ].map((m) => m[1]);
  const modules = [
    ...(/const SETTINGS_TRAINING_MODULES = \[([\s\S]*?)\n\s*\];/.exec(html)?.[1] ?? '')
      .matchAll(/label:'([^']+)',\s*category:'([^']+)',\s*skill:'([^']+)',\s*published:(true|false)/g),
  ].map((m) => ({ title: m[1], category: m[2], skill: m[3], published: m[4] === 'true' }));
  return { categories, skills, modules };
}

describe('the seeded training taxonomy (P5-T1)', () => {
  const source = prototype();

  it('reads the prototype at all, so the rest of this file means something', () => {
    expect(source.categories).toHaveLength(6);
    expect(source.skills).toHaveLength(6);
    expect(source.modules).toHaveLength(10);
  });

  it('seeds the prototype’s six categories, in its order', () => {
    expect(SEED_TRAINING_CATEGORIES.map(englishCategory)).toEqual(source.categories);
    expect(SEED_TRAINING_CATEGORIES.map((c) => c.displayOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('seeds Sales’s six skills, in its order, and nothing in the other five', () => {
    expect(SEED_TRAINING_SKILLS.map(englishSkill)).toEqual(source.skills);
    expect(new Set(SEED_TRAINING_SKILLS.map((s) => s.categoryCode))).toEqual(new Set(['SALES']));
    expect(SEED_TRAINING_SKILLS.map((s) => s.displayOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('seeds every module under the skill the prototype gives it, published as it shows them', () => {
    const skillLabel = new Map(SEED_TRAINING_SKILLS.map((s) => [s.code, englishSkill(s)]));
    const seeded = SEED_TRAINING_MODULES.map((m) => ({
      title: englishModule(m), skill: skillLabel.get(m.skillCode), published: m.publishState === 'published',
    }));
    expect(seeded).toEqual(source.modules.map(({ title, skill, published }) => ({ title, skill, published })));
  });

  /*
   * **The platform's Default template in Bahasa Indonesia** (P18.98-T7; OD-238, option 1; ADR-0179 §5). Pinned here,
   * word for word, because these are the words every new office starts with: *Sales*, *Recruitment* and *Closing* kept
   * English by the approved glossary (§A.3, §A.6), every other one Indonesian, and the English recorded for migration
   * 0046 is exactly what the seed changed.
   */
  it('P18.98-T7 writes the six categories, the skills and the modules in Bahasa Indonesia', () => {
    expect(SEED_TRAINING_CATEGORIES.map((c) => c.label)).toEqual([
      'Sales', 'Produk', 'Recruitment', 'Manajemen tim', 'Soft skills', 'Perusahaan dan KPM',
    ]);
    expect(SEED_TRAINING_CATEGORIES.map((c) => c.description)).toEqual([
      'Temukan prospek, gali kebutuhannya, jawab keberatan, dan lakukan closing.',
      'Apa yang dilindungi setiap produk, untuk siapa produk itu cocok, dan cara menjelaskannya.',
      'Temukan, dekati, dan rekrut orang-orang yang akan membangun tim Anda.',
      'Pimpin unit Anda: tetapkan goal, beri coaching kepada agen Anda, dan bantu agen baru memulai.',
      'Komunikasi, rasa percaya diri, dan kebiasaan harian di balik penjualan yang konsisten.',
      'Cara kerja perusahaan asuransi Anda dan KPM ini, serta kepada siapa bertanya untuk setiap hal.',
    ]);
    expect(SEED_TRAINING_SKILLS.map((s) => s.label)).toEqual([
      'Pencarian prospek', 'Analisis kebutuhan', 'Penanganan keberatan', 'Closing', 'Penjualan silang', 'Retensi nasabah',
    ]);
    expect(SEED_TRAINING_MODULES.map((m) => m.title)).toEqual([
      'Menyusun daftar prospek Anda', 'Teknik mendapatkan referensi', 'Script pendekatan prospek baru',
      'Melakukan analisis kebutuhan finansial', 'Mengajukan pertanyaan penggalian yang tepat',
      'Dasar-dasar penanganan keberatan', 'Teknik closing yang efektif', 'Menangani keberatan soal harga',
      'Mengenali peluang penjualan silang', 'Praktik terbaik mempertahankan nasabah',
    ]);
    // Every English word recorded is one the seed changed, and every one it changed is recorded.
    for (const c of SEED_TRAINING_CATEGORIES) {
      expect({ code: c.code, kept: WAS.categories[c.code].label === undefined }).toEqual({ code: c.code, kept: c.label === 'Sales' });
      expect(englishCategory(c) === c.label).toBe(c.label === 'Sales');
      expect(WAS.categories[c.code].description).not.toBe(c.description);
    }
    for (const s of SEED_TRAINING_SKILLS) expect({ code: s.code, kept: !(s.code in WAS.skills) }).toEqual({ code: s.code, kept: s.label === 'Closing' });
    for (const m of SEED_TRAINING_MODULES) expect(WAS.modules[m.code]).not.toBe(m.title);
  });

  it('numbers modules within their own skill, in the prototype’s order', () => {
    const bySkill = new Map<string, number[]>();
    for (const m of SEED_TRAINING_MODULES) {
      bySkill.set(m.skillCode, [...(bySkill.get(m.skillCode) ?? []), m.displayOrder]);
    }
    for (const orders of bySkill.values()) {
      expect(orders).toEqual(orders.map((_, i) => i + 1));
    }
  });

  it('holds codes a write would accept, never twice in one level, and every reference resolves', () => {
    for (const rows of [SEED_TRAINING_CATEGORIES, SEED_TRAINING_SKILLS, SEED_TRAINING_MODULES]) {
      const codes = rows.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(code).toMatch(CODE_PATTERN);
      for (const code of codes) expect(code).toBe(code.toUpperCase());
    }
    const categories = new Set(SEED_TRAINING_CATEGORIES.map((c) => c.code));
    const skills = new Set(SEED_TRAINING_SKILLS.map((s) => s.code));
    expect(SEED_TRAINING_SKILLS.filter((s) => !categories.has(s.categoryCode))).toEqual([]);
    expect(SEED_TRAINING_MODULES.filter((m) => !skills.has(m.skillCode))).toEqual([]);
  });
});
