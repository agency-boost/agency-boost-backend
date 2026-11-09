import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { EmailTemplateRenderer } from './email-renderer';
import { describeNotification, inboxAddress, IN_APP_TEMPLATES } from './inbox-copy';
import { NotificationTemplate, TEMPLATE_CHANNELS } from './notification.types';
import { quoteEmailLines } from './billing-quote.messages';

/** What `BillingService.sendQuote` writes: the server's figures for 13 leaders, annual, 7% (the shared fixture's Fix). */
const PAYLOAD = {
  fullName: 'Wulan Kartika', office: 'KPM 0602 · Bandung Dago', kpmCode: '0602', pic: 'Wulan Kartika', salesBy: 'Maya',
  startDate: '2026-11-12', endDate: '2027-11-11', generatedOn: '2026-11-05', plan: 'annual', tierRange: '11–20',
  customPricing: false, leaders: 13, standardMinor: 475_000_00, offerMinor: 375_000_00, annualDiscountMinor: 18_750_00,
  manualDiscountMinor: 24_937_00, finalMinor: 331_313_00, monthlyTotalMinor: 4_307_069_00, periodTotalMinor: 51_684_828_00,
};

describe('P19.4-T3 AC-10 the quote the Owner receives (ADR-0211 §5)', () => {
  it('P19.4-T3 AC-10 is a notice in the inbox and an email, nothing else', () => {
    expect(TEMPLATE_CHANNELS[NotificationTemplate.BILLING_QUOTE_RECEIVED]).toEqual(['in_app', 'email']);
    expect(IN_APP_TEMPLATES).toContain(NotificationTemplate.BILLING_QUOTE_RECEIVED);
    // The Owner has no billing page: the notice opens the inbox, where it is.
    expect(inboxAddress(NotificationTemplate.BILLING_QUOTE_RECEIVED, PAYLOAD)).toBeNull();
  });

  it('P19.4-T3 AC-10 the inbox row names the KPM, the plan, the leaders and the total, in either language', () => {
    expect(describeNotification(NotificationTemplate.BILLING_QUOTE_RECEIVED, PAYLOAD, SOURCE_READER)).toEqual({
      title: 'A subscription quote for KPM 0602 · Bandung Dago',
      detail: expect.stringMatching(/^Annual plan, 13 leaders: Rp\s?51\.684\.828\. The details are in your email\.$/),
    });
    expect(describeNotification(NotificationTemplate.BILLING_QUOTE_RECEIVED, PAYLOAD, readerIn('id'))).toEqual({
      title: 'Penawaran langganan untuk KPM 0602 · Bandung Dago',
      detail: expect.stringMatching(/^Paket tahunan, 13 leader: Rp\s?51\.684\.828\. Rinciannya ada di email Anda\.$/),
    });
  });

  it('P19.4-T3 AC-10 the email is the printable quote, section by section, both discounts listed when they apply', () => {
    const say = (s: Sentence) => render(s, SOURCE_READER);
    const lines = quoteEmailLines(PAYLOAD, say).filter(Boolean);
    expect(lines[0]).toBe('AgencyBoost has prepared a subscription quote for KPM 0602 · Bandung Dago. Its details are below.');
    expect(lines).toEqual(expect.arrayContaining([
      'Person in charge (PIC): Wulan Kartika',
      'Sales input by: Maya',
      'Annual plan',
      'Tier: 11–20 leaders',
      'Leaders on plan: 13',
    ]));
    const text = lines.join('\n');
    expect(text).toMatch(/Plan start date: 12 Nov 2026 · Plan end date: 11 Nov 2027/);
    expect(text).toMatch(/Annual discount: -Rp\s?18\.750\/leader\/mo/);
    expect(text).toMatch(/Manual discount: -Rp\s?24\.937\/leader\/mo/);
    expect(text).toMatch(/Final price \/ leader \/ mo: Rp\s?331\.313/);
    expect(text).toMatch(/Monthly total \(all leaders\): Rp\s?4\.307\.069/);
    expect(text).toMatch(/Annual total \(all leaders\): Rp\s?51\.684\.828/);
    expect(text).toContain('launch pricing');
  });

  it('P19.4-T3 AC-10 a six-month quote with no discount lists neither discount, and marks a custom tier', () => {
    const say = (s: Sentence) => render(s, SOURCE_READER);
    const text = quoteEmailLines({
      ...PAYLOAD, plan: 'six_months', tierRange: '101+', customPricing: true, annualDiscountMinor: 0, manualDiscountMinor: 0,
    }, say).join('\n');
    expect(text).toContain('6-month plan');
    expect(text).toContain('Tier: 101+ leaders (custom)');
    expect(text).not.toMatch(/discount/i);
    expect(text).toMatch(/6-month total \(all leaders\)/);
  });

  it('P19.4-T3 AC-10 the rendered email greets the Owner and carries the quote, in Indonesian by default', () => {
    const renderer = new EmailTemplateRenderer({ getOrThrow: () => 'https://app.agencyboost.test' } as never);
    const mail = renderer.render(NotificationTemplate.BILLING_QUOTE_RECEIVED, PAYLOAD, readerIn('id'));
    expect(mail.subject).toContain('Penawaran langganan untuk KPM 0602 · Bandung Dago');
    expect(mail.body).toContain('Wulan Kartika');
    expect(mail.body).toMatch(/Harga akhir \/ leader \/ bln: Rp\s?331\.313/);
    expect(mail.body).toContain('Tanggal mulai paket: 12 Nov 2026');
  });
});
