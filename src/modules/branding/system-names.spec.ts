import { FixedClock } from '@/common/clock/clock.port';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import type { BrandingReader } from './branding-reader';
import { inSystemName, PLATFORM_VOICE_TEMPLATES, SystemNames } from './system-name.port';
import { BrandingSystemNames } from './system-names';

const KPM = '66f0000000000000000000a1';

class Names extends SystemNames {
  asked: string[] = [];
  constructor(private readonly name: string | null) { super(); }
  async nameOf(kpmId: string) { this.asked.push(kpmId); return this.name; }
}

/** ***Nama sistem* in an email** (P19.21-T4 AC-1; ADR-0274): the port, its cache, and the platform's own voice. */
describe('P19.21-T4 AC-1 the system name in emails', () => {
  const MESSAGE = { subject: '[AgencyBoost] Peran Anda berubah', body: 'Halo Rina,\n\n…\n\n— AgencyBoost' };

  it('P19.21-T4 AC-1 a KPM’s member reads its name in the subject and the body', async () => {
    const names = new Names('Dynamic Smart System');
    const out = await inSystemName(names, { templateId: NotificationTemplate.ROLE_CHANGED, kpmId: KPM }, MESSAGE);
    expect(out).toEqual({ subject: '[Dynamic Smart System] Peran Anda berubah', body: 'Halo Rina,\n\n…\n\n— Dynamic Smart System' });
    expect(names.asked).toEqual([KPM]);
  });

  it('P19.21-T4 AC-1 an email with no KPM, a KPM with no name, or no port keeps AgencyBoost', async () => {
    const names = new Names('DSS');
    expect(await inSystemName(names, { templateId: NotificationTemplate.EMAIL_VERIFICATION }, MESSAGE)).toBe(MESSAGE);
    expect(await inSystemName(names, { templateId: NotificationTemplate.EMAIL_VERIFICATION, kpmId: null }, MESSAGE)).toBe(MESSAGE);
    expect(await inSystemName(new Names(null), { templateId: NotificationTemplate.ROLE_CHANGED, kpmId: KPM }, MESSAGE)).toBe(MESSAGE);
    expect(await inSystemName(undefined, { templateId: NotificationTemplate.ROLE_CHANGED, kpmId: KPM }, MESSAGE)).toBe(MESSAGE);
    expect(names.asked).toEqual([]);
  });

  it('P19.21-T4 AC-1 the platform speaking as itself keeps AgencyBoost: leader limits, an Owner’s invitation, a quote', async () => {
    expect(PLATFORM_VOICE_TEMPLATES).toEqual([
      NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED, NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED,
      NotificationTemplate.OWNER_INVITATION, NotificationTemplate.BILLING_QUOTE_RECEIVED,
    ]);
    const names = new Names('DSS');
    for (const templateId of PLATFORM_VOICE_TEMPLATES) {
      expect(await inSystemName(names, { templateId, kpmId: KPM }, MESSAGE)).toBe(MESSAGE);
    }
    expect(names.asked).toEqual([]);
  });

  it('P19.21-T4 AC-1 reads the KPM’s own row once a minute, and a read that fails is AgencyBoost', async () => {
    const clock = new FixedClock(new Date('2026-11-20T03:00:00Z'));
    let name: string | null = 'DSS';
    let fail = false;
    const reads: string[] = [];
    const reader = {
      ownOf: async (kpmId: string) => {
        reads.push(kpmId);
        if (fail) throw new Error('down');
        return { systemName: name };
      },
    } as unknown as BrandingReader;
    const port = new BrandingSystemNames(reader, clock);
    expect(await port.nameOf(KPM)).toBe('DSS');
    name = 'Other';
    expect(await port.nameOf(KPM)).toBe('DSS');
    expect(reads).toHaveLength(1);
    clock.advance(61_000);
    expect(await port.nameOf(KPM)).toBe('Other');
    fail = true;
    clock.advance(61_000);
    expect(await port.nameOf(KPM)).toBeNull();
    expect(await port.nameOf('not-an-id')).toBeNull();
    expect(reads).toHaveLength(3);
  });
});
