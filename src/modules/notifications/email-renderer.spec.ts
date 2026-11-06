import { ConfigService } from '@nestjs/config';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { EmailTemplateRenderer } from './email-renderer';
import { escapeHtml, toHtml } from './email-html';
import { AUTH_TEMPLATES, NotificationTemplate, TEMPLATE_CHANNELS } from './notification.types';

const config = { getOrThrow: () => 'https://app.agencyboost.test' } as unknown as ConfigService;
const renderer = new EmailTemplateRenderer(config);

/*
 * The P4-T14 copy below is the English the API writes (`SOURCE_READER`), named as its reader: a recipient who has chosen
 * nothing reads Bahasa Indonesia since the default went live (P18.10-T4's exit), and P18.10-T5 AC-5 below pins that.
 */

describe('what the transactional mail says (P4-T14)', () => {
  describe('the two templates that have no inbox row', () => {
    it('gives verification a link a person can open, and says what it is for', () => {
      // AC-4. This is the message whose absence meant a registered person could never
      // sign in — the link is the entire product of the email.
      const { subject, body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, {
        token: 'tok-123', fullName: 'Rina Wijaya',
      }, SOURCE_READER);
      expect(subject).toBe('[AgencyBoost] Verify your email address');
      expect(body).toContain('Hello Rina Wijaya,');
      expect(body).toContain('https://app.agencyboost.test/verify-email/tok-123');
      // P19-T1 (ADR-0190 §1, §4): the link opens a page with one button, and signing in no longer waits for it.
      expect(body).toContain('press Verify my email');
      expect(body).not.toContain('cannot sign in');
    });

    it('gives reset a link, and tells somebody who did not ask that nothing has changed', () => {
      const { subject, body } = renderer.render(NotificationTemplate.PASSWORD_RESET, {
        token: 'tok-456', fullName: 'Rina',
      }, SOURCE_READER);
      expect(subject).toBe('[AgencyBoost] Reset your password');
      expect(body).toContain('https://app.agencyboost.test/reset-password/tok-456');
      expect(body).toContain('Your password has not changed');
    });

    it('points at the app, not at this API', () => {
      // A person opens a page, not an endpoint, and the two differ in every environment.
      const { body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't' }, SOURCE_READER);
      expect(body).toContain('https://app.agencyboost.test/verify-email/t');
    });

    it('does not put a double slash in the link when the origin carries a trailing one', () => {
      const trailing = { getOrThrow: () => 'https://app.test/' } as unknown as ConfigService;
      const { body } = new EmailTemplateRenderer(trailing)
        .render(NotificationTemplate.PASSWORD_RESET, { token: 't' }, SOURCE_READER);
      expect(body).toContain('https://app.test/reset-password/t');
      expect(body).not.toContain('app.test//');
    });

    it('P19.4-T3 AC-6 invites a new KPM’s Owner by email: the KPM named, the set-password link, how long it works (ADR-0212 §2)', () => {
      const payload = { token: 'tok-789', fullName: 'Wulan Kartika', office: 'KPM 0602 · Bandung Dago', days: 7 };
      const en = renderer.render(NotificationTemplate.OWNER_INVITATION, payload, SOURCE_READER);
      expect(en.subject).toBe('[AgencyBoost] You are the Owner of KPM 0602 · Bandung Dago on AgencyBoost');
      expect(en.body).toContain('https://app.agencyboost.test/reset-password/tok-789');
      expect(en.body).toContain('for 7 days');
      const id = renderer.render(NotificationTemplate.OWNER_INVITATION, payload, readerIn('id'));
      expect(id.subject).toBe('[AgencyBoost] Anda pemilik KPM 0602 · Bandung Dago di AgencyBoost');
      expect(id.body).toContain('menjadikan Anda pemilik KPM 0602 · Bandung Dago');
      // Email only (ADR-0010, ADR-0212 §4): no inbox row, and nothing by WhatsApp.
      expect(TEMPLATE_CHANNELS[NotificationTemplate.OWNER_INVITATION]).toEqual(['email']);
      expect(en.body).not.toMatch(/whatsapp/i);
    });

    it('greets somebody whose name it does not have, without a hole in the sentence', () => {
      const { body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't' }, SOURCE_READER);
      expect(body).toContain('Hello,');
      expect(body).not.toContain('undefined');
    });
  });

  describe('every other template', () => {
    it('says what the inbox says, rather than a second set of words', () => {
      /*
       * ADR-0010 makes the inbox authoritative and `inbox-copy.ts` the one place a row's
       * words live — "a change here changes what six books say". An email composing its
       * own wording is how the two channels come to disagree about the same event.
       */
      const { subject, body } = renderer.render(NotificationTemplate.JOIN_REQUEST_APPROVED, {
        fullName: 'Rina',
      }, SOURCE_READER);
      expect(subject).toBe('[AgencyBoost] You are in');
      expect(body).toContain('Your request was approved. You now have a leader.');
      expect(body).toContain('https://app.agencyboost.test/notifications');
    });

    it('P12-T4 AC-7 a calendar notice’s email links to the address its row opens, built from APP_ORIGIN', () => {
      const entryId = '66f0000000000000000000e1';
      const invited = renderer.render(NotificationTemplate.CALENDAR_INVITATION, { entryId, date: '2026-10-05' }, SOURCE_READER);
      expect(invited.subject).toBe('[AgencyBoost] You have a new invitation');
      expect(invited.body).toContain(`https://app.agencyboost.test/calendar?entry=${entryId}&date=2026-10-05`);
      const cancelled = renderer.render(NotificationTemplate.CALENDAR_ENTRY_CHANGED, {
        entryId, date: '2026-10-05', change: 'cancelled',
      }, SOURCE_READER);
      expect(cancelled.subject).toBe('[AgencyBoost] An entry on your calendar was cancelled');
      expect(cancelled.body).toContain('https://app.agencyboost.test/calendar?date=2026-10-05');
      expect(cancelled.body).not.toContain('/notifications');
    });

    it('P18.7-T7 AC-4 an event reminder’s email names its time and place, as its inbox row does', () => {
      const { subject, body } = renderer.render(NotificationTemplate.EVENT_REMINDER, {
        title: 'Kickoff 2026', startsAt: '2026-11-09T02:00:00.000Z', timezone: 'Asia/Jakarta', location: 'Kantor KPM',
      }, SOURCE_READER);
      expect(subject).toBe('[AgencyBoost] Kickoff 2026 is coming up');
      expect(body).toContain('9 Nov 2026, 09.00 · Kantor KPM');
      expect(body).not.toContain('Check the time');
    });

    it('renders every template that declares an email channel, with no empty body', () => {
      // A template added without copy would otherwise ship an email saying nothing.
      const emailTemplates = Object.entries(TEMPLATE_CHANNELS)
        .filter(([, channels]) => channels.includes('email'))
        .map(([id]) => id);
      expect(emailTemplates.length).toBeGreaterThan(5);

      for (const id of emailTemplates) {
        const { subject, body } = renderer.render(id, { token: 't', fullName: 'X' }, SOURCE_READER);
        expect(subject.startsWith('[AgencyBoost] ')).toBe(true);
        expect(subject.length).toBeGreaterThan('[AgencyBoost] '.length);
        expect(body.trim().length).toBeGreaterThan(20);
      }
    });
  });
});

/**
 * **P18.10-T5 AC-5 — the email in its recipient's language** (ADR-0179 §7): the subject, the greeting, the body and the
 * sign-off, for the reader `NotificationService` hands the renderer; with none, a reader who has chosen nothing —
 * Bahasa Indonesia, since the default went live at P18.10-T4's exit.
 */
describe('P18.10-T5 AC-5 the email in the recipient’s language', () => {
  const ID = readerIn('id');

  it('AC-5 writes the verification email in Indonesian, the link and the name as they are', () => {
    const { subject, body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, {
      token: 'tok-123', fullName: 'Rina Wijaya',
    }, ID);
    expect(subject).toBe('[AgencyBoost] Verifikasi alamat email Anda');
    expect(body).toBe([
      'Halo Rina Wijaya,',
      '',
      // P19-T1 (ADR-0190 §1, §4): it said *Anda tidak dapat masuk sebelum melakukannya.* until 2026-11-04.
      'Buka tautan ini, lalu tekan Verifikasi email saya untuk memverifikasi alamat Anda.',
      '',
      'https://app.agencyboost.test/verify-email/tok-123',
      '',
      'Jika Anda tidak membuat akun AgencyBoost, abaikan email ini — tidak ada yang terjadi sampai tautan dibuka.',
      '',
      '— AgencyBoost',
    ].join('\n'));
  });

  it('AC-5 writes the reset email in Indonesian, and greets somebody whose name it lacks', () => {
    const { subject, body } = renderer.render(NotificationTemplate.PASSWORD_RESET, { token: 'tok-456' }, ID);
    expect(subject).toBe('[AgencyBoost] Atur ulang kata sandi Anda');
    expect(body.split('\n')[0]).toBe('Halo,');
    expect(body).toContain('Buka tautan ini untuk membuat kata sandi baru.');
    expect(body).toContain('https://app.agencyboost.test/reset-password/tok-456');
    expect(body).toContain('Kata sandi Anda tidak berubah, dan tautan ini akan kedaluwarsa dengan sendirinya.');
  });

  it('AC-5 writes every other email in the inbox’s words, in Indonesian', () => {
    const approved = renderer.render(NotificationTemplate.JOIN_REQUEST_APPROVED, { fullName: 'Rina' }, ID);
    expect(approved.subject).toBe('[AgencyBoost] Anda sudah bergabung');
    expect(approved.body).toContain('Halo Rina,');
    expect(approved.body).toContain('Permintaan Anda disetujui. Sekarang Anda memiliki leader.');
    expect(approved.body).toContain('https://app.agencyboost.test/notifications');
    // A template with no detail of its own still says where to look, in the reader's language.
    const unknown = renderer.render('something.new', {}, ID);
    expect(unknown.body).toContain('Buka AgencyBoost untuk melihat perubahannya.');
  });

  it('AC-5 writes an event’s time in the recipient’s figures', () => {
    const kickoff = { title: 'Kickoff 2026', startsAt: '2026-11-09T02:00:00.000Z', timezone: 'Asia/Jakarta', location: 'Kantor KPM' };
    expect(renderer.render(NotificationTemplate.EVENT_REMINDER, kickoff, ID).body).toContain('9 Nov 2026, 09.00 · Kantor KPM');
    expect(renderer.render(NotificationTemplate.EVENT_REMINDER, kickoff, readerIn('en')).body).toContain('9 Nov 2026, 09:00 · Kantor KPM');
  });

  it('AC-5 writes for a reader who has chosen nothing when it is given none: Bahasa Indonesia, as the default is live', () => {
    const { subject, body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't', fullName: 'Rina' });
    expect(subject).toBe('[AgencyBoost] Verifikasi alamat email Anda');
    expect(body.startsWith('Halo Rina,')).toBe(true);
    expect({ subject, body }).toEqual(renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't', fullName: 'Rina' }, ID));
  });

  it('AC-5 renders every email template in Indonesian, none of it the English', () => {
    const emailTemplates = Object.entries(TEMPLATE_CHANNELS).filter(([, channels]) => channels.includes('email')).map(([id]) => id);
    for (const id of emailTemplates) {
      const en = renderer.render(id, { token: 't', fullName: 'X' }, readerIn('en'));
      const inIndonesian = renderer.render(id, { token: 't', fullName: 'X' }, ID);
      expect({ id, same: en.subject === inIndonesian.subject }).toEqual({ id, same: false });
      expect(inIndonesian.body.startsWith('Halo X,')).toBe(true);
    }
  });
});

/**
 * **UI-111 — the email change's two emails** (UI V1, 2026-10-30; ADR-0181): the link that applies it, to the new address,
 * opening the app's `/verify-email-change/<token>`; and a notice to the old one naming the new address, with **no link
 * at all** — nothing in it applies the change, and what it asks of somebody who did not ask is a new password.
 */
describe('UI-111 the email change’s emails (ADR-0181)', () => {
  it('UI-111 the link to the new address opens the app’s verify-email-change page, and says nothing changes until then', () => {
    const { subject, body } = renderer.render(NotificationTemplate.EMAIL_CHANGE_VERIFICATION, {
      token: 'tok-789', fullName: 'Agus Prasetyo',
    }, SOURCE_READER);
    expect(subject).toBe('[AgencyBoost] Confirm your new email address');
    expect(body).toContain('Hello Agus Prasetyo,');
    expect(body).toContain('https://app.agencyboost.test/verify-email-change/tok-789');
    expect(body).toContain('Your email does not change until you do.');
  });

  it('UI-111 the notice to the old address names the new one, tells somebody who did not ask what to do, and has no link', () => {
    const { subject, body } = renderer.render(NotificationTemplate.EMAIL_CHANGE_REQUESTED, {
      fullName: 'Agus Prasetyo', newEmail: 'agus.baru@kpm.test',
    }, SOURCE_READER);
    expect(subject).toBe('[AgencyBoost] Your email address is being changed');
    expect(body).toContain('asked to change its email to agus.baru@kpm.test.');
    expect(body).toContain('If this was not you, change your password now');
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('UI-111 both in Indonesian for an Indonesian reader', () => {
    const ID = readerIn('id');
    const link = renderer.render(NotificationTemplate.EMAIL_CHANGE_VERIFICATION, { token: 't', fullName: 'Agus' }, ID);
    expect(link.subject).toBe('[AgencyBoost] Konfirmasi alamat email baru Anda');
    expect(link.body).toContain('Email Anda tidak berubah sebelum Anda membukanya.');
    const notice = renderer.render(NotificationTemplate.EMAIL_CHANGE_REQUESTED, { fullName: 'Agus', newEmail: 'a@b.test' }, ID);
    expect(notice.subject).toBe('[AgencyBoost] Alamat email Anda sedang diubah');
    expect(notice.body).toContain('meminta email akun ini diubah menjadi a@b.test.');
    expect(notice.body).toContain('Jika ini bukan Anda, segera ubah kata sandi Anda');
  });
});

/**
 * **P18.11-T18 — the HTML alternative** (ADR-0182): every email is multipart, its HTML derived from the rendered text,
 * so the text stays the one source of the words. Escaped before it is shaped, so nothing a person typed becomes markup.
 */
describe('P18.11-T18 the HTML alternative, derived from the text', () => {
  it('P18.11-T18 escapes every character that could open markup or close an attribute', () => {
    expect(escapeHtml(`Tom & Jerry <b>"hi"</b> it's`)).toBe('Tom &amp; Jerry &lt;b&gt;&quot;hi&quot;&lt;/b&gt; it&#39;s');
  });

  it('P18.11-T18 a <script> somebody typed arrives as text, never as a tag', () => {
    const html = toHtml('Hello <script>alert("x")</script>,\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('P18.11-T18 a link becomes an anchor to itself, its text the URL, with the sentence\'s full stop left outside', () => {
    const html = toHtml('Open https://app.agencyboost.test/verify-email/tok-1. Or https://app.test/a?x=1&y=2');
    expect(html).toContain(
      '<a href="https://app.agencyboost.test/verify-email/tok-1" style="word-break:break-all">https://app.agencyboost.test/verify-email/tok-1</a>.',
    );
    // The query's ampersand escaped in the attribute and the text alike.
    expect(html).toContain('<a href="https://app.test/a?x=1&amp;y=2" style="word-break:break-all">https://app.test/a?x=1&amp;y=2</a>');
  });

  it('P18.11-T18 only http and https are links: a javascript: URL somebody typed stays text', () => {
    const html = toHtml('javascript:alert(1) and ftp://files.test/x');
    expect(html).not.toContain('<a ');
  });

  it('P18.11-T18 a blank line starts a paragraph, a single newline is a line break, and Windows line ends read the same', () => {
    const html = toHtml('Hello Rina,\r\n\r\nLine one\nline two\n\n\n\n— AgencyBoost\n');
    const paragraphs = html.match(/<p style="[^"]*">[\s\S]*?<\/p>/g) ?? [];
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toContain('>Hello Rina,</p>');
    expect(paragraphs[1]).toContain('>Line one<br>\nline two</p>');
    expect(paragraphs[2]).toContain('>— AgencyBoost</p>');
  });

  it('P18.11-T18 is a small, whole document: UTF-8, no image, nothing that tracks an open', () => {
    const html = toHtml('Hi');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toMatch(/<img|<script|<link|url\(/i);
  });

  it('P18.11-T18 the verification email\'s HTML says what its text says, its link an anchor', () => {
    const { body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 'tok-123', fullName: 'Rina Wijaya' }, SOURCE_READER);
    const html = toHtml(body);
    expect(html).toContain('>Hello Rina Wijaya,</p>');
    expect(html).toContain('<a href="https://app.agencyboost.test/verify-email/tok-123"');
    expect(html).toContain('— AgencyBoost');
  });
});

/**
 * **P19-T1 — the password changed, and every auth link pointing home** (UI-163, ADR-0190 §5–§6): *"Kata sandi Anda
 * diubah"* after a reset or a change, with no token; and each auth mail's link built on the issuing environment's
 * `APP_ORIGIN`, so a staging mail never opens production's page, or the other way round.
 */
describe('P19-T1 the auth mail', () => {
  it('P19-T1 AC-5 says the password changed, in Indonesian as the owner asked, and links to a reset — no token', () => {
    const { subject, body } = renderer.render(NotificationTemplate.PASSWORD_CHANGED, { fullName: 'Rina Wijaya' }, readerIn('id'));
    expect(subject).toBe('[AgencyBoost] Kata sandi Anda diubah');
    expect(body).toBe([
      'Halo Rina Wijaya,',
      '',
      'Kata sandi akun AgencyBoost Anda baru saja diubah, dan semua perangkat yang masuk dengan kata sandi lama sudah '
        + 'dikeluarkan.',
      '',
      'Jika ini bukan Anda, segera atur ulang kata sandi Anda lewat tautan ini:',
      'https://app.agencyboost.test/forgot-password',
      '',
      '— AgencyBoost',
    ].join('\n'));
  });

  it('P19-T1 AC-5 says it in English to an English reader', () => {
    const { subject, body } = renderer.render(NotificationTemplate.PASSWORD_CHANGED, { fullName: 'Rina' }, SOURCE_READER);
    expect(subject).toBe('[AgencyBoost] Your password was changed');
    expect(body).toContain('If this was not you, reset your password now with this link:');
  });

  it.each([
    ['production', 'https://agencyboost.id'],
    ['staging', 'https://staging.agencyboost.id'],
  ])('P19-T1 AC-8 every auth mail’s link starts with %s’s APP_ORIGIN', (_env, origin) => {
    const issued = new EmailTemplateRenderer({ getOrThrow: () => origin } as unknown as ConfigService);
    const links: Record<string, string[]> = {};
    for (const id of AUTH_TEMPLATES) {
      const { body } = issued.render(id, { token: 'tok-1', fullName: 'Rina', newEmail: 'rina.baru@kpm.test' }, readerIn('id'));
      links[id] = body.match(/https?:\/\/\S+/g) ?? [];
    }
    expect(links).toEqual({
      'auth.email_verification': [`${origin}/verify-email/tok-1`],
      'auth.password_reset': [`${origin}/reset-password/tok-1`],
      'auth.password_changed': [`${origin}/forgot-password`],
      'auth.email_change_verification': [`${origin}/verify-email-change/tok-1`],
      // The notice to the old address has no link at all (ADR-0181).
      'auth.email_change_requested': [],
      // A linked login's (ADR-0199 §2): the link to the other login's page; the notice none; the linked notice *Profil saya*.
      'auth.account_link_request': [`${origin}/link-account/tok-1`],
      'auth.account_link_requested': [],
      'auth.account_linked': [`${origin}/profile`],
    });
  });
});

/**
 * **UI-169 item 5 — a linked login's three emails** (ADR-0199 §2): the link, to the other login's address, naming who asked;
 * the notice to the starting login's, with no link that applies anything; and the notice to both once it is linked.
 */
describe('P19.2-T1 AC-8 a linked login’s emails (ADR-0199)', () => {
  it('P19.2-T1 AC-8 the link names who asked and opens the app’s link-account page', () => {
    const { subject, body } = renderer.render(NotificationTemplate.ACCOUNT_LINK_REQUEST, {
      token: 'tok-link', fullName: 'Wilson Tanoto', requesterName: 'Wilson Tanoto', requesterEmail: 'owner@kpm0417.test',
    }, SOURCE_READER);
    expect(subject).toBe('[AgencyBoost] Link this login to another');
    expect(body).toContain('Wilson Tanoto (owner@kpm0417.test) asked to link their AgencyBoost login to this one');
    expect(body).toContain('https://app.agencyboost.test/link-account/tok-link');
    expect(body).toContain('Nothing is linked until the link is opened');
  });

  it('P19.2-T1 AC-8 the notice to the starting login names the other address, says what to do, and has no link', () => {
    const { subject, body } = renderer.render(NotificationTemplate.ACCOUNT_LINK_REQUESTED, {
      fullName: 'Wilson Tanoto', linkEmail: 'wilson@agencyboost.test',
    }, SOURCE_READER);
    expect(subject).toBe('[AgencyBoost] Your login is being linked');
    expect(body).toContain('asked to link it to the login wilson@agencyboost.test.');
    expect(body).toContain('If this was not you, change your password now');
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('P19.2-T1 AC-8 the linked notice names the other login and points at Profil saya to remove it, in Indonesian too', () => {
    const en = renderer.render(NotificationTemplate.ACCOUNT_LINKED, { fullName: 'Wilson', otherEmail: 'a@b.test' }, SOURCE_READER);
    expect(en.subject).toBe('[AgencyBoost] Two logins were linked');
    expect(en.body).toContain('now linked to the login a@b.test');
    expect(en.body).toContain('remove the link in My profile');
    const id = renderer.render(NotificationTemplate.ACCOUNT_LINKED, { fullName: 'Wilson', otherEmail: 'a@b.test' }, readerIn('id'));
    expect(id.subject).toBe('[AgencyBoost] Dua akun telah ditautkan');
    expect(id.body).toContain('sekarang tertaut ke akun a@b.test');
    expect(id.body).toContain('hapus tautan itu di Profil saya');
    const link = renderer.render(NotificationTemplate.ACCOUNT_LINK_REQUEST, {
      token: 't', fullName: 'B', requesterName: 'Wilson', requesterEmail: 'owner@kpm0417.test',
    }, readerIn('id'));
    expect(link.subject).toBe('[AgencyBoost] Tautkan akun ini ke akun lain');
    expect(link.body).toContain('meminta akun AgencyBoost-nya ditautkan ke akun ini');
  });
});
