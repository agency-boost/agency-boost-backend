import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { Sentence } from '@/common/i18n/sentence';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { KPM_REPORT } from '@/domain/constants';
import { KPM_REPORT_REFUSALS } from './kpm-report.messages';

/** What a *Kirim ke owner* link names: the KPM, the month, the Super Admin who made it, when it dies, and its own id. */
export interface ReportLinkClaims {
  kpmId: string;
  month: string;
  /** The Super Admin who made it: the report is built as theirs, and a revoked Super Admin's links open nothing. */
  userId: string;
  /** Seconds since the epoch. */
  expiresAt: number;
  /** The link's own id, in both audit entries — the making and every opening — so one can be traced to the other. */
  linkId: string;
}

/** The label the signing key is derived under: the report's key is not the access token's key. */
const KEY_LABEL = 'agencyboost:kpm-report-link:v1';
const DAY_SECONDS = 24 * 60 * 60;

const dead = (sentence: Sentence<'NOT_FOUND'>) => new DomainException(ErrorCode.NOT_FOUND, sentence, HttpStatus.NOT_FOUND);

/**
 * **The *Kirim ke owner* link's token** (P19.24-T2 AC-1; ADR-0280 §5; OD-359, OD-428): `<payload>.<signature>`, both
 * base64url — the payload the claims as JSON, the signature HMAC-SHA256 over it under a key derived from the API's
 * signing secret for this use alone. **Stateless**: nothing is stored, so a link is good until it expires
 * (`KPM_REPORT.LINK_TTL_DAYS`) and is not spent by opening it — WhatsApp's own preview, and the Owner opening it on a
 * phone and again on a laptop, would spend a one-time link. **It is no bearer credential**: the route that opens it asks
 * for the KPM's Owner or a KPM Admin, signed in (ADR-0280 §5), so a forwarded link discloses nothing.
 */
export class ReportLinkSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('The report link signing secret must be at least 32 characters.');
    this.key = createHmac('sha256', secret).update(KEY_LABEL).digest();
  }

  private signature(payload: string): Buffer {
    return createHmac('sha256', this.key).update(payload).digest();
  }

  /** A fresh link for `kpmId` and `month`, made now by `userId`; `now` is the clock's. */
  sign(claims: { kpmId: string; month: string; userId: string }, now: Date): { token: string; claims: ReportLinkClaims } {
    const full: ReportLinkClaims = {
      ...claims,
      expiresAt: Math.floor(now.getTime() / 1000) + KPM_REPORT.LINK_TTL_DAYS * DAY_SECONDS,
      linkId: randomBytes(9).toString('base64url'),
    };
    const payload = Buffer.from(JSON.stringify({ v: 1, k: full.kpmId, m: full.month, s: full.userId, e: full.expiresAt, i: full.linkId }))
      .toString('base64url');
    return { token: `${payload}.${this.signature(payload).toString('base64url')}`, claims: full };
  }

  /**
   * **The claims of a link that is whole and alive**, or `404 NOT_FOUND` saying which: a token that is not ours or was
   * altered (*tidak valid*), and one past its time (*kedaluwarsa*). The signature is compared in constant time.
   */
  open(token: string, now: Date): ReportLinkClaims {
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
      throw dead(KPM_REPORT_REFUSALS.NOT_FOUND.linkNotValid);
    }
    const given = Buffer.from(parts[1], 'base64url');
    const wanted = this.signature(parts[0]);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw dead(KPM_REPORT_REFUSALS.NOT_FOUND.linkNotValid);
    let body: { v?: unknown; k?: unknown; m?: unknown; s?: unknown; e?: unknown; i?: unknown };
    try {
      body = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      throw dead(KPM_REPORT_REFUSALS.NOT_FOUND.linkNotValid);
    }
    if (body.v !== 1 || typeof body.k !== 'string' || typeof body.m !== 'string' || typeof body.s !== 'string'
      || typeof body.e !== 'number' || typeof body.i !== 'string') {
      throw dead(KPM_REPORT_REFUSALS.NOT_FOUND.linkNotValid);
    }
    if (body.e * 1000 <= now.getTime()) throw dead(KPM_REPORT_REFUSALS.NOT_FOUND.expired);
    return { kpmId: body.k, month: body.m, userId: body.s, expiresAt: body.e, linkId: body.i };
  }
}
