import type { Gender, WorkStatus } from '@/domain/constants';

/**
 * **What every seeded person records** (ADR-0158, P18.5-T4): a birth date, a gender, the month they
 * joined Prudential and how they work in their office — so the person page's *Personal* card and
 * `/profile` have something to show for everybody a reviewer signs in as, and *Not recorded* is only
 * ever the deliberate case.
 *
 * **Derived from the email, never random**, so a reseed gives everybody the same four and a test can
 * name them. The gender follows the pronoun the seed already gives the person (`users.pronoun`); a
 * person with none is given one from the same derivation. Everybody is an adult by decades, and joined
 * the insurer at 22 or later and no later than 2025 — so no seeded value is ever refused by the rules
 * the import and registration apply.
 */
export interface SeedPersonal {
  dateOfBirth: string;
  gender: Gender;
  companyJoinMonth: string;
  workStatus: WorkStatus;
}

/** A small, stable hash: the same address gives the same number on every run and every machine. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function seedPersonalFor(email: string, pronoun?: 'she' | 'he' | 'they' | null): SeedPersonal {
  const h = hashOf(email.toLowerCase());
  const birthYear = 1972 + (h % 26); // 1972–1997
  const joinYear = Math.min(2025, birthYear + 22 + ((h >>> 5) % 9));
  return {
    dateOfBirth: `${birthYear}-${pad(1 + ((h >>> 3) % 12))}-${pad(1 + ((h >>> 7) % 28))}`,
    gender: pronoun === 'she' ? 'female' : pronoun === 'he' ? 'male' : (h >>> 11) % 2 === 0 ? 'female' : 'male',
    companyJoinMonth: `${joinYear}-${pad(1 + ((h >>> 13) % 12))}`,
    // One in four part-time, the rest full-time: an office has both.
    workStatus: (h >>> 17) % 4 === 0 ? 'part_time' : 'full_time',
  };
}
