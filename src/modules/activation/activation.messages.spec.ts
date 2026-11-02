import {
  ACTIVATION_DATA_LINK_KINDS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK,
} from '@/domain/constants';
import { english, indonesian } from '../../../test/i18n';
import { ACTIVATION_MESSAGES, ACTIVATION_REFUSALS, completesWhenOf, dataLinkLabelOf } from './activation.messages';

/**
 * **P18.98-T5 — the activation module's words, in both languages** (ADR-0179 §7). The routes' own specs read most of
 * these as a request does; this pins what no route reaches on its own — a plural, a count past a thousand — and that
 * each link kind's English is the registry's, byte for byte.
 */
describe('P18.98-T5 the activation catalogue', () => {
  it('UI-025 Mark left is retired: none of its refusals is in the catalogue any more', () => {
    for (const code of ['NOT_A_NEW_HIRE', 'NEW_HIRE_HAS_REPORTS', 'NEW_HIRE_NOT_MARKABLE', 'NEW_HIRE_ALREADY_LEFT']) {
      expect([code, code in ACTIVATION_REFUSALS]).toEqual([code, false]);
    }
  });

  it('UI-027 (D-26) names a pecah telor’s closing in both languages', () => {
    expect(english(ACTIVATION_MESSAGES.pecahTelorClosing)).toBe('First sale (date recorded by hand)');
    expect(indonesian(ACTIVATION_MESSAGES.pecahTelorClosing)).toBe('Pecah telor (tanggal dicatat manual)');
  });

  it('AC-3 writes a count past a thousand the Indonesian way, and keeps the English as it was', () => {
    const many = ACTIVATION_REFUSALS.VALIDATION_FAILED.aspectCount({ min: 1, max: 20, count: 1200 });
    expect(english(many)).toBe('A checklist has 1–20 aspects; this one has 1200.');
    expect(indonesian(many)).toBe('Checklist memiliki 1–20 aspek; checklist ini memiliki 1.200.');
    const left = ACTIVATION_REFUSALS.ACTIVATION_INCOMPLETE.notDone({ left: 2, total: 16 });
    expect(english(left)).toBe('2 of 16 items are not done yet. The checklist is complete when every item is.');
    expect(indonesian(left)).toBe('2 dari 16 item belum selesai. Checklist selesai jika semua item sudah selesai.');
  });

  it('AC-4 says what completes each link kind: the registry’s English, byte for byte, and its Indonesian', () => {
    expect([
      'feature:goals', 'feature:leads', 'feature:activity', 'training:PROSPECT_LIST', 'sales:first', 'sales:closings:3',
      'coaching:weekly:4',
    ].map((link) => english(completesWhenOf(link)))).toEqual([
      ACTIVATION_LINK_KINDS['feature:goals'].completesWhen,
      ACTIVATION_LINK_KINDS['feature:leads'].completesWhen,
      ACTIVATION_LINK_KINDS['feature:activity'].completesWhen,
      ACTIVATION_TRAINING_LINK.completesWhen,
      ACTIVATION_DATA_LINK_KINDS['sales:first'].completesWhen,
      ACTIVATION_DATA_LINK_KINDS['sales:closings:3'].completesWhen,
      ACTIVATION_DATA_LINK_KINDS['coaching:weekly:4'].completesWhen,
    ]);
    expect(indonesian(completesWhenOf('training:ANY_MODULE'))).toBe('rekrut telah menyelesaikan modul training tersebut');
    expect(indonesian(completesWhenOf('sales:closings:3')))
      .toBe('rekrut telah memiliki 3 sales leads yang dibayar dan diterbitkan sejak bergabung');
    expect([dataLinkLabelOf('sales:first'), dataLinkLabelOf('sales:closings:3'), dataLinkLabelOf('coaching:weekly:4')]
      .map((label) => [english(label), indonesian(label)]))
      .toEqual([['Sales data', 'Data penjualan'], ['Sales data', 'Data penjualan'], ['Coaching sessions', 'Sesi coaching']]);
  });
});
