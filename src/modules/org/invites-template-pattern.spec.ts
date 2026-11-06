import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { readerIn } from '@/common/i18n/reader';
import type { DomainException } from '@/common/errors/domain.exception';
import { InvitesService } from './invites.service';

const KPM = '66f0000000000000000000a1';
const ctx = new RequestContext('u-1', 'none', {
  membershipId: '66f000000000000000000101', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/** The service with nothing behind it but the template's format: what `addAgent` asks before anything else. */
const service = (pattern: { agentCodePattern: string; agentCodeExample: string } | null) => {
  const never = new Proxy({}, { get: () => () => { throw new Error('reached past the code check'); } });
  const analytics = pattern ? { forOffice: async () => ({ config: { uploadRules: pattern } }) } : null;
  return new InvitesService(
    never as never, never as never, never as never, never as never, never as never, never as never, never as never,
    never as never, never as never, never as never, never as never, never as never, new FixedClock(new Date('2026-11-06T02:00:00Z')),
    null, null, analytics as never,
  );
};
const attempt = async (svc: InvitesService, agentCode: string) => {
  try {
    await svc.addAgent(ctx, { agentCode, fullName: 'Dewi', phone: '0812-0000-0000' } as never, 'https://app.test');
    return 'passed';
  } catch (err) {
    const refusal = err as DomainException;
    return refusal.code === 'VALIDATION_FAILED' ? [refusal.code, refusal.message, refusal.messageFor(readerIn('id'))] : 'passed';
  }
};

/**
 * **P19.5-T2 (ADR-0214 §7, amending ADR-0158 §4): inside a KPM on a template, a new code follows the template's format**
 * — *Tambah anggota* (`POST /new-hires/agents`) refuses a code that is not in it before anything is read or written,
 * naming the template's example; without a template's format the global `AGENT_CODE_PATTERN` stands.
 */
describe('P19.5-T2 Tambah anggota follows the template’s agent-code format', () => {
  const prudential = { agentCodePattern: '^[0-9]{8}$', agentCodeExample: '70012345' };

  it('P19.5-T2 AC-5 refuses a code not in the template’s format, naming its example, in both languages', async () => {
    expect(await attempt(service(prudential), '80777')).toEqual([
      'VALIDATION_FAILED',
      'agentCode is not in the agent code format of this KPM\'s template — for example 70012345',
      'agentCode tidak sesuai format kode agen di template KPM ini — contohnya 70012345',
    ]);
  });

  it('P19.5-T2 AC-5 takes a code in the format — the check is passed and the form goes on', async () => {
    expect(await attempt(service(prudential), '70012399')).toBe('passed');
  });

  it('P19.5-T2 a template’s format may allow what the global pattern does not, and the reverse', async () => {
    const letters = { agentCodePattern: '^[A-Z]{3}-[0-9]{3}$', agentCodeExample: 'PRU-001' };
    expect(await attempt(service(letters), 'PRU-123')).toBe('passed');
    expect((await attempt(service(letters), '80777'))[0]).toBe('VALIDATION_FAILED');
  });

  it('P19.5-T2 with no template’s format, the global pattern stands: digits only, 3 to 32', async () => {
    expect(await attempt(service(null), '80777')).toBe('passed');
    expect(await attempt(service(null), 'PRU-1')).toEqual([
      'VALIDATION_FAILED', 'agentCode must be digits only, 3 to 32 of them', 'agentCode hanya boleh berisi angka, 3 sampai 32 digit',
    ]);
  });
});
