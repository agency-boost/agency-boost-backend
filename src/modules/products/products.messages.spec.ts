import type { Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { PRODUCTS_REFUSALS } from './products.messages';

const SAY = PRODUCTS_REFUSALS.VALIDATION_FAILED;

/**
 * **Every sentence the products module refuses with, in both languages** (P18.98-T5 AC-2): each entry said with its
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
];

describe('P18.98-T5 AC-2 the products module’s sentences', () => {
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

  it('groups a count of a thousand or more the Indonesian way', () => {
    expect(english(SAY.sendEveryProduct({ count: 1200 }))).toBe('Send every product of this company, once each — 1200 of them.');
    expect(indonesian(SAY.sendEveryProduct({ count: 1200 })))
      .toBe('Kirim setiap produk perusahaan ini, masing-masing sekali — semuanya 1.200.');
  });
});
