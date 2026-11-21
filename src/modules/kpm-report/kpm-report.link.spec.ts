import { KPM_REPORT } from '@/domain/constants';
import { ReportLinkSigner } from './kpm-report.link';

/** **P19.24-T2 AC-1 — the *Kirim ke owner* link's token** (ADR-0280 §5; OD-428): signed, alive seven days, never spent. */
describe('P19.24-T2 the KPM report link', () => {
  const NOW = new Date('2026-11-20T03:00:00Z');
  const signer = new ReportLinkSigner('x'.repeat(40));
  const claims = { kpmId: '66f0000000000000000000a1', month: '2026-10', userId: '66f0000000000000000000e1' };

  it('P19.24-T2 AC-1 opens what it names, again and again until it expires', () => {
    const { token, claims: made } = signer.sign(claims, NOW);
    expect(made.expiresAt).toBe(NOW.getTime() / 1000 + KPM_REPORT.LINK_TTL_DAYS * 86_400);
    const opened = signer.open(token, NOW);
    expect(opened).toMatchObject({ ...claims, linkId: made.linkId });
    // Not spent by opening: WhatsApp's preview and a second device open it too.
    expect(signer.open(token, new Date(NOW.getTime() + 60_000))).toEqual(opened);
  });

  it('P19.24-T2 AC-1 refuses an expired link, saying so', () => {
    const { token } = signer.sign(claims, NOW);
    const later = new Date(NOW.getTime() + KPM_REPORT.LINK_TTL_DAYS * 86_400_000);
    expect(() => signer.open(token, later)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    try {
      signer.open(token, later);
    } catch (err) {
      expect(JSON.stringify((err as { message?: unknown }).message ?? err)).toMatch(/expired|kedaluwarsa/);
    }
  });

  it('P19.24-T2 AC-1 refuses an altered link, another key’s, and nonsense', () => {
    const { token } = signer.sign(claims, NOW);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, k: 'other', m: '2026-10', s: claims.userId, e: 9_999_999_999, i: 'x' })).toString('base64url');
    for (const bad of [`${forged}.${signature}`, `${payload}.${signature.slice(1)}A`, 'nonsense', '', `${payload}.`]) {
      expect(() => signer.open(bad, NOW)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    }
    expect(() => new ReportLinkSigner('y'.repeat(40)).open(token, NOW)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('P19.24-T2 AC-1 will not sign with a short secret', () => {
    expect(() => new ReportLinkSigner('short')).toThrow();
  });
});
