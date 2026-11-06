import type { Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { PRODUCTS_REFUSALS, referenceWords } from './products.messages';

const SAY = PRODUCTS_REFUSALS.VALIDATION_FAILED;

/**
 * **Every sentence the products module refuses with, in both languages** (P18.10-T5 AC-2): each entry said with its
 * values, the values — a product's name, a field, a code — kept as they are, and every entry here.
 */
const CASES: [entry: keyof typeof SAY, sentence: Message, values: string[]][] = [
  ['nothingToChange', SAY.nothingToChange, []],
  ['withdrawn', SAY.withdrawn({ name: 'PRUMapan' }), ['PRUMapan']],
  ['companysFields', SAY.companysFields({ fields: ['code', 'channel'], allowed: ['displayName', 'description'] }),
    ['code, channel', 'displayName, description']],
  ['notOverridable', SAY.notOverridable({ field: 'channel' }), ['channel']],
  ['rejectionReason', SAY.rejectionReason, ['"']],
  ['nothingPending', SAY.nothingPending, []],
  ['notASlot', SAY.notASlot({ slot: 'poster', slots: ['brochure', 'riplay'] }), ['poster', 'brochure, riplay']],
  ['replacementNotOnShelf', SAY.replacementNotOnShelf, []],
  ['sendEveryProduct', SAY.sendEveryProduct({ count: 12 }), ['12']],
  ['codeTaken', SAY.codeTaken({ code: 'PRUMAPAN' }), ['PRUMAPAN']],
  ['scheduleGaps', SAY.scheduleGaps({ years: [1, 3] }), ['1, 3']],
  ['productCodeShape', SAY.productCodeShape, []],
  // P19.4-T4 (ADR-0209 §2, §10): riders and the delete.
  ['attachAtLeastOne', SAY.attachAtLeastOne, []],
  ['attachNotOnShelf', SAY.attachNotOnShelf, []],
  ['attachToRider', SAY.attachToRider({ name: 'CI Coverage+' }), ['CI Coverage+']],
  ['attachNotActive', SAY.attachNotActive({ name: 'PRUMapan' }), ['PRUMapan']],
  ['baseAttaches', SAY.baseAttaches, []],
  ['deleteOnSale', SAY.deleteOnSale({ name: 'PRUMapan' }), ['PRUMapan']],
];

describe('P18.10-T5 AC-2 the products module’s sentences', () => {
  it.each(CASES)('%s is said in English and in Indonesian, its values kept as they are', (_entry, sentence, values) => {
    const [en, id] = [english(sentence), indonesian(sentence)];
    expect(en).toBeTruthy();
    expect(id).toBeTruthy();
    expect(id).not.toBe(en);
    for (const value of values) {
      expect(en).toContain(value);
      expect(id).toContain(value);
    }
  });

  it('has a case for every entry', () => {
    expect(CASES.map(([entry]) => entry).sort()).toEqual(Object.keys(SAY).sort());
  });

  it('P19.4-T4 AC-4 says the riders spec’s own sentence verbatim: "Pilih minimal satu produk dasar"', () => {
    expect(indonesian(SAY.attachAtLeastOne)).toBe('Pilih minimal satu produk dasar');
  });

  it('P19.4-T4 AC-13 names what still references a product, in both languages, and only what does', () => {
    const IN_USE = PRODUCTS_REFUSALS.PRODUCT_IN_USE;
    const reasons = referenceWords({ activations: 2, scriptApprovals: 1, riders: 0 });
    expect(english(IN_USE.referenced({ name: 'PGB', reasons })))
      .toBe('PGB cannot be deleted: 2 KPMs sell it; 1 KPM has a script for it. It stays withdrawn.');
    expect(indonesian(IN_USE.referenced({ name: 'PGB', reasons })))
      .toBe('PGB tidak dapat dihapus: 2 KPM menjualnya; 1 KPM memiliki script untuknya. Produk tetap berstatus ditarik.');
    expect(referenceWords({ activations: 0, scriptApprovals: 0, riders: 1 }))
      .toEqual({ en: '1 rider is attached to it', id: '1 rider terpasang padanya' });
  });

  it('P19.4-T4 AC-4 refuses a kind change under an attachment, and a rider’s office write, in both languages', () => {
    const KIND = PRODUCTS_REFUSALS.PRODUCT_KIND_IN_USE;
    expect(english(KIND.baseHasRiders({ name: 'SOFI', riders: 1 }))).toContain('while 1 rider attach to it');
    expect(indonesian(KIND.baseHasRiders({ name: 'SOFI', riders: 2 }))).toContain('selama 2 rider terpasang');
    expect(english(KIND.riderHasBases({ name: 'CI+', bases: 2 }))).toContain('attached to 2 base products');
    expect(indonesian(PRODUCTS_REFUSALS.PRODUCT_IS_RIDER.followsItsBase({ name: 'CI+' }))).toContain('CI+ adalah rider');
  });

  it('groups a count of a thousand or more the Indonesian way', () => {
    expect(english(SAY.sendEveryProduct({ count: 1200 }))).toBe('Send every product of this company, once each — 1200 of them.');
    expect(indonesian(SAY.sendEveryProduct({ count: 1200 })))
      .toBe('Kirim setiap produk perusahaan ini, masing-masing sekali — semuanya 1.200.');
  });
});
