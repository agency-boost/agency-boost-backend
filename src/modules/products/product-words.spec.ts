import type { Reader } from '@/common/i18n/reader';
import { SEED_PRODUCTS, SEED_REPLY_BY_NEED, type SeedProduct } from '@/domain/constants/product-catalog';
import { SEED_PRODUCTS_ID, SEED_REPLY_BY_NEED_ID } from '@/domain/constants/product-words-id';
import { productWordsFor } from './product-words';

const ID: Reader = { language: 'id', figures: 'id' };
const EN: Reader = { language: 'en', figures: 'en' };
const seed = (code: string) => SEED_PRODUCTS.find((p) => p.code === code) as SeedProduct;

/** Every English string of a seed product, by the field it sits in. */
const fieldsOf = (p: SeedProduct): [string, string][] => [
  ['tagline', p.tagline],
  ...p.benefits.map((b, i): [string, string] => [`benefits.${i}`, b]),
  ['differentiator', p.differentiator],
  ['bestFor', p.bestFor],
  ...Object.entries(p.defaultAttackPlan).flatMap(([key, value]): [string, string][] =>
    (Array.isArray(value) ? value.map((v, i): [string, string] => [`plan.${key}.${i}`, v]) : [[`plan.${key}`, value as string]])),
];

describe('UI-107 the seed products in Bahasa Indonesia — the platform’s words, field for field', () => {
  it('UI-107 every seed product has its Indonesian, and nothing else does', () => {
    expect(Object.keys(SEED_PRODUCTS_ID).sort()).toEqual(SEED_PRODUCTS.map((p) => p.code).sort());
  });

  it.each(SEED_PRODUCTS.map((p) => [p.code]))('UI-107 %s: every list the seed’s length, every blank still blank', (code) => {
    const en = seed(code);
    const id = SEED_PRODUCTS_ID[code];
    expect(id.benefits).toHaveLength(en.benefits.length);
    expect(id.defaultAttackPlan.benefits).toHaveLength(en.defaultAttackPlan.benefits.length);
    for (const key of ['goodFit', 'opening', 'fullScript', 'objectionTheySay', 'nextAction'] as const) {
      expect([key, id.defaultAttackPlan[key] === '']).toEqual([key, en.defaultAttackPlan[key] === '']);
    }
  });

  it('UI-107 one English sentence is one Indonesian sentence, across every product', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const p of SEED_PRODUCTS) {
      const say = productWordsFor(p.code, ID);
      for (const [field, text] of fieldsOf(p)) {
        if (text === '') continue;
        const id = say(text);
        if (seen.has(text) && seen.get(text) !== id) clashes.push(`${p.code} ${field}`);
        seen.set(text, id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('UI-107 every seed sentence reads in Indonesian for an Indonesian reader — no English left', () => {
    const untranslated = SEED_PRODUCTS.flatMap((p) => {
      const say = productWordsFor(p.code, ID);
      return fieldsOf(p).filter(([, text]) => text !== '' && say(text) === text).map(([field]) => `${p.code} ${field}`);
    });
    expect(untranslated).toEqual([]);
  });

  it('UI-107 the eight replies read in Indonesian under every product, and are kept whole', () => {
    for (const [need, reply] of Object.entries(SEED_REPLY_BY_NEED)) {
      expect(productWordsFor('PRUMAPAN', ID)(reply)).toBe(SEED_REPLY_BY_NEED_ID[need as keyof typeof SEED_REPLY_BY_NEED_ID]);
    }
  });

  it('UI-107 PRUSehat reads as the owner’s worked example', () => {
    const say = productWordsFor('PRUSEHAT', ID);
    const en = seed('PRUSEHAT');
    expect(say(en.tagline)).toBe('Asuransi kesehatan as-billed dengan No Claim Bonus.');
    expect(say(en.defaultAttackPlan.opening)).toBe(
      'Bapak/Ibu ingin asuransi kesehatan yang langsung membayar tagihan rumah sakit tanpa ribet, dan PRUSehat memberikan itu.',
    );
    expect(say(en.defaultAttackPlan.objectionTheySay)).toBe('Saya sudah punya asuransi kesehatan dari kantor.');
    expect(say(en.defaultAttackPlan.nextAction)).toBe(
      'Boleh saya buatkan ilustrasi dengan plan yang sesuai rumah sakit dan kamar pilihan Bapak/Ibu?',
    );
  });
});

describe('UI-107 productWordsFor — the platform’s words translated, a company’s or an office’s as typed', () => {
  const prusehat = seed('PRUSEHAT');

  it('UI-107 an English reader reads every field as stored', () => {
    expect(productWordsFor('PRUSEHAT', EN)(prusehat.tagline)).toBe(prusehat.tagline);
  });

  it('UI-107 a word a company or an office typed is shown as typed, in Indonesian too (ADR-0179 §5)', () => {
    const say = productWordsFor('PRUSEHAT', ID);
    expect(say('Our office’s own words for PRUSehat.')).toBe('Our office’s own words for PRUSehat.');
    // One character changed is a company's word, not the platform's.
    expect(say(`${prusehat.tagline} `)).toBe(`${prusehat.tagline} `);
  });

  it('UI-107 a product the platform never seeded is shown as typed', () => {
    expect(productWordsFor('OUR_OWN', ID)(prusehat.tagline)).toBe(prusehat.tagline);
  });

  it('UI-107 a sentence is translated by its own product: another product’s seed English is not looked up', () => {
    const mapan = seed('PRUMAPAN');
    expect(productWordsFor('PRUSEHAT', ID)(mapan.tagline)).toBe(mapan.tagline);
  });

  it('UI-107 a blank stays blank', () => {
    expect(productWordsFor('PRUSEHAT', ID)('')).toBe('');
  });
});
