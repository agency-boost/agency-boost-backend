import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_PATTERN } from '@/common/validation/fields';
import {
  SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS,
} from './training-taxonomy';

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
    expect(SEED_TRAINING_CATEGORIES.map((c) => c.label)).toEqual(source.categories);
    expect(SEED_TRAINING_CATEGORIES.map((c) => c.displayOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('seeds Sales’s six skills, in its order, and nothing in the other five', () => {
    expect(SEED_TRAINING_SKILLS.map((s) => s.label)).toEqual(source.skills);
    expect(new Set(SEED_TRAINING_SKILLS.map((s) => s.categoryCode))).toEqual(new Set(['SALES']));
    expect(SEED_TRAINING_SKILLS.map((s) => s.displayOrder)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('seeds every module under the skill the prototype gives it, published as it shows them', () => {
    const skillLabel = new Map(SEED_TRAINING_SKILLS.map((s) => [s.code, s.label]));
    const seeded = SEED_TRAINING_MODULES.map((m) => ({
      title: m.title, skill: skillLabel.get(m.skillCode), published: m.publishState === 'published',
    }));
    expect(seeded).toEqual(source.modules.map(({ title, skill, published }) => ({ title, skill, published })));
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
