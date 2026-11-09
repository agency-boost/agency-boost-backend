import {
  addressIn, describeMail, isReservedAddress, MAIL_PRESETS, MAIL_PROVIDERS, MailConfig, MailConfigError,
  mailConfigProblems, mailSettingsFrom, resolveMailProvider, SMTP_SOCKET_TIMEOUT_MS, SMTP_TIMEOUT_MS_DEFAULT,
  transportOptionsFrom,
} from './mail-provider';

/** A configuration as `ConfigService` or the raw environment answers it: a key, or nothing. */
function config(values: Record<string, unknown>): MailConfig {
  return { get: (key) => values[key] };
}

const FROM = 'AgencyBoost <no-reply@agencyboost.id>';
const credentials = { SMTP_USER: 'user@agencyboost.id', SMTP_PASSWORD: 'secret-1', MAIL_FROM: FROM };

/** The problems `mailSettingsFrom` throws, keyed as boot validation reports them. */
function problemsOf(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(mailConfigProblems(config(values)).map((p) => [p.key, p.message]));
}

describe('the mail provider, chosen by the environment (P18.11-T18, ADR-0182)', () => {
  describe('which provider sends', () => {
    it.each(MAIL_PROVIDERS)('P18.11-T18 MAIL_PROVIDER=%s chooses it', (provider) => {
      expect(resolveMailProvider(config({ MAIL_PROVIDER: provider }))).toEqual({ provider, key: 'MAIL_PROVIDER' });
    });

    it('P18.11-T18 falls back to MAIL_TRANSPORT when MAIL_PROVIDER is unset, so an older env file boots as it did', () => {
      expect(resolveMailProvider(config({ MAIL_TRANSPORT: 'log' }))).toEqual({ provider: 'log', key: 'MAIL_TRANSPORT' });
      expect(resolveMailProvider(config({ MAIL_TRANSPORT: 'smtp' }))).toEqual({ provider: 'smtp', key: 'MAIL_TRANSPORT' });
      // Blank is unset, as `.env.example` writes an optional key.
      expect(resolveMailProvider(config({ MAIL_PROVIDER: '  ', MAIL_TRANSPORT: 'log' })).provider).toBe('log');
    });

    it('P18.11-T18 defaults to smtp when neither key is written', () => {
      expect(resolveMailProvider(config({}))).toEqual({ provider: 'smtp', key: null });
      expect(resolveMailProvider(config({ MAIL_PROVIDER: null, MAIL_TRANSPORT: '' }))).toEqual({ provider: 'smtp', key: null });
    });

    it('P18.11-T18 MAIL_PROVIDER wins over MAIL_TRANSPORT', () => {
      expect(resolveMailProvider(config({ MAIL_PROVIDER: 'gmail', MAIL_TRANSPORT: 'log' })).provider).toBe('gmail');
    });

    it('P18.11-T18 refuses a value neither key takes, by name — the test command reads the raw environment', () => {
      expect(() => resolveMailProvider(config({ MAIL_PROVIDER: 'postmark' }))).toThrow(MailConfigError);
      expect(() => resolveMailProvider(config({ MAIL_PROVIDER: 'postmark' }))).toThrow(/MAIL_PROVIDER must be one of gmail, sendgrid/);
      expect(() => resolveMailProvider(config({ MAIL_TRANSPORT: 'gmail' }))).toThrow(/MAIL_TRANSPORT must be smtp or log, not "gmail"/);
    });
  });

  describe('the presets', () => {
    it.each([
      ['gmail', 'smtp.gmail.com', 465, true],
      ['sendgrid', 'smtp.sendgrid.net', 587, false],
      ['mailjet', 'in-v3.mailjet.com', 587, false],
      ['clicksend', 'smtp.clicksend.com', 587, false],
      ['ses', 'email-smtp.ap-southeast-3.amazonaws.com', 587, false],
    ] as const)('P18.11-T18 %s dials %s:%d, secure %s', (provider, host, port, secure) => {
      const user = provider === 'sendgrid' ? 'apikey' : credentials.SMTP_USER;
      const settings = mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: provider, SMTP_USER: user }));
      expect(settings).toMatchObject({ provider, host, port, secure, user, pass: 'secret-1', from: FROM });
      expect(MAIL_PRESETS[provider]).toMatchObject({ host, port });
    });

    it('P18.11-T18 SMTP_HOST and SMTP_PORT, when written, override a preset; TLS follows the port', () => {
      const settings = mailSettingsFrom(config({
        ...credentials, MAIL_PROVIDER: 'gmail', SMTP_USER: 'agencyboostid@gmail.com', SMTP_HOST: 'smtp-relay.gmail.com', SMTP_PORT: '587',
        MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
      }));
      expect(settings).toMatchObject({ host: 'smtp-relay.gmail.com', port: 587, secure: false });
      // Said at start-up, because the likeliest override is the last provider's host left in the file.
      expect(settings.warnings).toEqual([
        'SMTP_HOST=smtp-relay.gmail.com overrides the gmail preset\'s smtp.gmail.com. If it is left from another provider, '
          + 'remove SMTP_HOST and SMTP_PORT: the preset fills both.',
      ]);
    });

    it('P18.11-T18 warns when SES\'s host is left in the file after switching to Gmail; says nothing when it is the preset\'s own', () => {
      const switched = mailSettingsFrom(config({
        MAIL_PROVIDER: 'gmail', SMTP_HOST: 'email-smtp.ap-southeast-3.amazonaws.com', SMTP_PORT: '587',
        SMTP_USER: 'agencyboostid@gmail.com', SMTP_PASSWORD: 'x', MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
      }));
      expect(switched.warnings).toEqual([expect.stringMatching(/^SMTP_HOST=email-smtp\.ap-southeast-3\.amazonaws\.com overrides the gmail preset/)]);
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses', SMTP_HOST: MAIL_PRESETS.ses.host })).warnings).toEqual([]);
    });

    it('P18.11-T18 a plain relay is SMTP_HOST, on 587 unless SMTP_PORT says, and needs no credentials', () => {
      expect(mailSettingsFrom(config({ MAIL_FROM: FROM, SMTP_HOST: 'localhost' }))).toMatchObject({
        provider: 'smtp', host: 'localhost', port: 587, secure: false, user: '', pass: '',
      });
      // As ConfigService answers it, validated: a number.
      expect(mailSettingsFrom(config({ MAIL_FROM: FROM, SMTP_HOST: 'mx.example', SMTP_PORT: 465 }))).toMatchObject({ port: 465, secure: true });
    });

    it('P18.11-T18 log needs no host, no port and no credentials', () => {
      expect(mailSettingsFrom(config({ MAIL_PROVIDER: 'log', MAIL_FROM: FROM }))).toEqual({
        provider: 'log', host: '', port: 0, secure: false, user: '', pass: '', from: FROM, replyTo: undefined,
        timeoutMs: SMTP_TIMEOUT_MS_DEFAULT, warnings: [],
      });
    });

    it('P18.11-T18 reads MAIL_REPLY_TO and SMTP_TIMEOUT_MS, and the default timeout when it is unset', () => {
      const settings = mailSettingsFrom(config({
        MAIL_FROM: FROM, SMTP_HOST: 'localhost', MAIL_REPLY_TO: ' support@agencyboost.id ', SMTP_TIMEOUT_MS: '8000',
      }));
      expect(settings).toMatchObject({ replyTo: 'support@agencyboost.id', timeoutMs: 8_000 });
      expect(mailSettingsFrom(config({ MAIL_FROM: FROM, SMTP_HOST: 'localhost' })).replyTo).toBeUndefined();
    });
  });

  describe('what is refused, by key', () => {
    it('P18.11-T18 SMTP_HOST is required for a plain relay alone', () => {
      expect(problemsOf({ MAIL_FROM: FROM })).toEqual({ SMTP_HOST: expect.stringMatching(/required when the mail provider is smtp/) });
      expect(problemsOf({ MAIL_FROM: FROM, MAIL_TRANSPORT: 'smtp' })).toHaveProperty('SMTP_HOST');
      expect(problemsOf({ ...credentials, MAIL_PROVIDER: 'ses' })).toEqual({});
      expect(problemsOf({ MAIL_FROM: FROM, MAIL_PROVIDER: 'log' })).toEqual({});
    });

    it.each(['gmail', 'sendgrid', 'mailjet', 'clicksend', 'ses'] as const)(
      'P18.11-T18 %s refuses missing credentials, saying what goes in each',
      (provider) => {
        const problems = problemsOf({ MAIL_FROM: FROM, MAIL_PROVIDER: provider, SMTP_PASSWORD: '   ' });
        expect(problems.SMTP_USER).toBe(`is required when MAIL_PROVIDER is ${provider}: ${MAIL_PRESETS[provider].user}.`);
        expect(problems.SMTP_PASSWORD).toBe(`is required when MAIL_PROVIDER is ${provider}: ${MAIL_PRESETS[provider].pass}.`);
      },
    );

    it('P18.11-T18 SendGrid\'s user is the literal word apikey', () => {
      expect(problemsOf({ ...credentials, MAIL_PROVIDER: 'sendgrid', SMTP_USER: 'me@agencyboost.id' }).SMTP_USER)
        .toMatch(/must be the literal word apikey when MAIL_PROVIDER is sendgrid, not "me@agencyboost.id"/);
      expect(problemsOf({ ...credentials, MAIL_PROVIDER: 'sendgrid', SMTP_USER: 'apikey' })).toEqual({});
    });

    it('P18.11-T18 MAIL_FROM is required, whatever the provider', () => {
      expect(problemsOf({ MAIL_PROVIDER: 'log' })).toEqual({ MAIL_FROM: expect.stringMatching(/is required/) });
      expect(problemsOf({ MAIL_PROVIDER: 'log', MAIL_FROM: ' ' })).toHaveProperty('MAIL_FROM');
    });

    it.each(['0', '-1', '2.5', 'soon'])('P18.11-T18 refuses SMTP_PORT and SMTP_TIMEOUT_MS of %j', (value) => {
      expect(Object.keys(problemsOf({ MAIL_FROM: FROM, SMTP_HOST: 'h', SMTP_PORT: value, SMTP_TIMEOUT_MS: value })))
        .toEqual(['SMTP_TIMEOUT_MS', 'SMTP_PORT']);
    });

    it('P18.11-T18 throws every problem at once, in a message naming each key', () => {
      expect(() => mailSettingsFrom(config({ MAIL_PROVIDER: 'mailjet' })))
        .toThrow('The mail configuration is unusable: MAIL_FROM is required');
      try {
        mailSettingsFrom(config({ MAIL_PROVIDER: 'mailjet' }));
      } catch (err) {
        expect((err as MailConfigError).problems.map((p) => p.key)).toEqual(['MAIL_FROM', 'SMTP_USER', 'SMTP_PASSWORD']);
      }
    });

    it('P18.11-T18 mailConfigProblems passes on a failure that is not the configuration\'s', () => {
      const broken: MailConfig = { get: () => { throw new Error('the reader broke'); } };
      expect(() => mailConfigProblems(broken)).toThrow('the reader broke');
    });
  });

  describe('Gmail', () => {
    const gmail = {
      MAIL_PROVIDER: 'gmail', SMTP_USER: 'agencyboostid@gmail.com', MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
    };

    it('P18.11-T18 reads an App Password without the spaces Google shows it with', () => {
      expect(mailSettingsFrom(config({ ...gmail, SMTP_PASSWORD: 'abcd efgh ijkl mnop' })).pass).toBe('abcdefghijklmnop');
      expect(mailSettingsFrom(config({ ...gmail, SMTP_PASSWORD: ' abcd\tefgh ijkl mnop ' })).pass).toBe('abcdefghijklmnop');
    });

    it('P18.11-T18 leaves every other provider\'s password exactly as written', () => {
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'mailjet', SMTP_PASSWORD: ' a b ' })).pass).toBe(' a b ');
    });

    it('P18.11-T18 says nothing when MAIL_FROM is the signed-in account, whatever the case', () => {
      expect(mailSettingsFrom(config({ ...gmail, SMTP_PASSWORD: 'x', MAIL_FROM: 'AgencyBoost <AgencyBoostID@gmail.com>' })).warnings).toEqual([]);
    });

    it('P18.11-T18 warns when MAIL_FROM is another address: Gmail rewrites From, and DMARC will not align', () => {
      const { warnings } = mailSettingsFrom(config({ ...gmail, SMTP_PASSWORD: 'x', MAIL_FROM: FROM }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/MAIL_FROM is no-reply@agencyboost\.id, but Gmail is signed in as agencyboostid@gmail\.com/);
      expect(warnings[0]).toMatch(/likely to land in spam/);
      expect(warnings[0]).toContain('"AgencyBoost <agencyboostid@gmail.com>"');
    });
  });

  describe('the other warnings', () => {
    it.each(['sendgrid', 'mailjet', 'clicksend', 'ses'] as const)(
      'P18.11-T18 warns when %s sends as a gmail.com address, which fails DMARC',
      (provider) => {
        const user = provider === 'sendgrid' ? 'apikey' : 'u';
        const { warnings } = mailSettingsFrom(config({
          MAIL_PROVIDER: provider, SMTP_USER: user, SMTP_PASSWORD: 'p', MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
        }));
        expect(warnings).toEqual([expect.stringMatching(new RegExp(`a gmail\\.com address sent through ${provider}`))]);
      },
    );

    it('P18.11-T18 says nothing for an address on the product\'s own domain, or through a plain relay', () => {
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses' })).warnings).toEqual([]);
      expect(mailSettingsFrom(config({ SMTP_HOST: 'h', MAIL_FROM: 'x@googlemail.com' })).warnings).toEqual([]);
    });

    it('P18.11-T18 warns when MAIL_TRANSPORT disagrees with MAIL_PROVIDER about sending, and is ignored', () => {
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses', MAIL_TRANSPORT: 'log' })).warnings)
        .toEqual(['MAIL_TRANSPORT=log is ignored: MAIL_PROVIDER=ses decides. Remove MAIL_TRANSPORT.']);
      // Agreeing is said nothing about: an env file adding MAIL_PROVIDER beside MAIL_TRANSPORT=smtp is the migration.
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses', MAIL_TRANSPORT: 'smtp' })).warnings).toEqual([]);
      expect(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses' })).warnings).toEqual([]);
      expect(mailSettingsFrom(config({ SMTP_HOST: 'h', MAIL_FROM: FROM, MAIL_TRANSPORT: 'smtp' })).warnings).toEqual([]);
    });
  });

  describe('addresses no relay can deliver to', () => {
    it.each([
      'rina@kpm.test', 'Rina <rina@kpm.TEST>', 'a@b.example', 'a@x.invalid', 'a@localhost', 'a@kpm.test.',
      'a@example.com', 'a@mail.example.org', 'a@example.net',
    ])('P18.11-T18 %s is reserved', (address) => {
      expect(isReservedAddress(address)).toBe(true);
    });

    it.each(['agencyboostid@gmail.com', 'a@agencyboost.id', 'a@notexample.com', 'a@example.com.id', 'no-at-sign'])(
      'P18.11-T18 %s is not',
      (address) => {
        expect(isReservedAddress(address)).toBe(false);
      },
    );

    it('P18.11-T18 reads the address inside a display name', () => {
      expect(addressIn('AgencyBoost <No-Reply@AgencyBoost.id>')).toBe('no-reply@agencyboost.id');
      expect(addressIn(' bare@agencyboost.id ')).toBe('bare@agencyboost.id');
    });
  });

  describe('the transport', () => {
    it('P18.11-T18 a preset requires TLS before it authenticates; implicit TLS on 465 needs no upgrade', () => {
      const sendgrid = mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'sendgrid', SMTP_USER: 'apikey' }));
      expect(transportOptionsFrom(sendgrid)).toEqual({
        host: 'smtp.sendgrid.net', port: 587, secure: false, requireTLS: true,
        auth: { user: 'apikey', pass: 'secret-1' },
        connectionTimeout: SMTP_TIMEOUT_MS_DEFAULT, greetingTimeout: SMTP_TIMEOUT_MS_DEFAULT, socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      });
      const gmail = mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'gmail' }));
      expect(transportOptionsFrom(gmail)).toMatchObject({ port: 465, secure: true, requireTLS: false });
    });

    it('P18.11-T18 a plain relay upgrades when offered, and logs in only when given a user', () => {
      const local = mailSettingsFrom(config({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', MAIL_FROM: FROM, SMTP_TIMEOUT_MS: 2_500 }));
      expect(transportOptionsFrom(local)).toMatchObject({
        host: '127.0.0.1', port: 1025, secure: false, requireTLS: false, auth: undefined, connectionTimeout: 2_500, greetingTimeout: 2_500,
      });
    });
  });

  describe('the line the log and the terminal print', () => {
    it('P18.11-T18 names the provider, the host, the port, TLS, the login and the sender — never the password', () => {
      const gmail = mailSettingsFrom(config({
        MAIL_PROVIDER: 'gmail', SMTP_USER: 'agencyboostid@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop',
        MAIL_FROM: 'AgencyBoost <agencyboostid@gmail.com>',
      }));
      const line = describeMail(gmail);
      expect(line).toBe(
        'provider gmail via smtp.gmail.com:465 (TLS), as agencyboostid@gmail.com, from AgencyBoost <agencyboostid@gmail.com>',
      );
      expect(line).not.toContain('abcd');
      expect(describeMail(mailSettingsFrom(config({ ...credentials, MAIL_PROVIDER: 'ses' })))).toContain('(STARTTLS), as user@');
      expect(describeMail(mailSettingsFrom(config({ SMTP_HOST: 'h', MAIL_FROM: FROM }))))
        .toBe(`provider smtp via h:587 (STARTTLS if offered), as (no login), from ${FROM}`);
      expect(describeMail(mailSettingsFrom(config({ MAIL_PROVIDER: 'log', MAIL_FROM: FROM })))).toMatch(/^provider log: .* none is sent$/);
    });
  });
});
