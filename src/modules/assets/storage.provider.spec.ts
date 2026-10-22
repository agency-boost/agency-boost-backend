jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn(() => ({ file: jest.fn() })) })),
}));

import { HttpStatus } from '@nestjs/common';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { GcsAdapter } from './gcs.adapter';
import { STORAGE_PROVIDER, storageFor } from './storage.provider';
import { StoragePort } from './storage.port';
import { UnconfiguredStorage } from './unconfigured-storage';

const clock = new FixedClock(new Date('2026-10-19T03:00:00Z'));
const configOf = (values: Record<string, string | undefined>) => ({
  get: (key: string) => values[key],
  getOrThrow: (key: string) => {
    if (values[key] === undefined) throw new Error(`${key} is not set.`);
    return values[key];
  },
}) as never;

describe('P18.7-T2 the storage binding (ADR-0153, D12)', () => {
  it('P18.7-T2 binds the bucket when GCS_BUCKET names one, in any environment', () => {
    for (const NODE_ENV of ['development', 'test', 'staging', 'production']) {
      const storage = storageFor(configOf({ NODE_ENV, GCS_BUCKET: 'agencyboost-staging-assets', STORAGE_KEY_PREFIX: 'staging' }), clock);
      expect(storage).toBeInstanceOf(GcsAdapter);
    }
  });

  it.each(['development', 'test'])('P18.7-T2 binds storage that refuses when %s has no bucket — the API still boots', (NODE_ENV) => {
    expect(storageFor(configOf({ NODE_ENV }), clock)).toBeInstanceOf(UnconfiguredStorage);
    expect(storageFor(configOf({ NODE_ENV, GCS_BUCKET: '' }), clock)).toBeInstanceOf(UnconfiguredStorage);
    // A blank value reaches here raw: `ConfigService.get` falls back to `process.env` when validation unset it.
    expect(storageFor(configOf({ NODE_ENV, GCS_BUCKET: '   ' }), clock)).toBeInstanceOf(UnconfiguredStorage);
  });

  it.each(['staging', 'production', undefined])('P18.7-T2 refuses to choose for %s without a bucket: a deployed API always has storage', (NODE_ENV) => {
    expect(() => storageFor(configOf({ NODE_ENV }), clock)).toThrow(`GCS_BUCKET is required when NODE_ENV is ${NODE_ENV ?? 'unset'}`);
  });

  it('P18.7-T2 is registered as the StoragePort, built from the config and the clock', () => {
    expect(STORAGE_PROVIDER).toMatchObject({ provide: StoragePort, useFactory: storageFor });
    expect((STORAGE_PROVIDER as { inject: unknown[] }).inject).toHaveLength(2);
  });
});

describe('P18.7-T2 storage that is not configured (D12)', () => {
  const storage = new UnconfiguredStorage();
  const owner = { kind: 'kpm', kpmId: 'k' } as const;
  const calls: [string, () => Promise<unknown>][] = [
    ['createSignedUpload', () => storage.createSignedUpload()],
    ['createSignedUrl', () => storage.createSignedUrl()],
    ['describe', () => storage.describe()],
    ['remove', () => storage.remove()],
    ['copy', () => storage.copy()],
    ['putObject', () => storage.putObject()],
  ];

  it.each(calls)('P18.7-T2 refuses %s with 503 STORAGE_NOT_CONFIGURED, saying so plainly', async (_name, call) => {
    const failure = await call().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DomainException);
    expect((failure as DomainException).code).toBe(ErrorCode.STORAGE_NOT_CONFIGURED);
    expect((failure as DomainException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((failure as DomainException).message).toBe(
      'File storage is not configured on this server, so files cannot be uploaded or opened here.',
    );
  });

  it('P18.7-T2 refuses through the port, as the asset service calls it', async () => {
    const port: StoragePort = storage;
    await expect(port.createSignedUpload({ owner, folder: 'training', filename: 'a.pdf', mimeType: 'application/pdf' }))
      .rejects.toMatchObject({ code: ErrorCode.STORAGE_NOT_CONFIGURED });
    await expect(port.putObject({ owner, folder: 'f', name: 'n', mimeType: 'application/pdf', body: Buffer.from('x') }))
      .rejects.toMatchObject({ code: ErrorCode.STORAGE_NOT_CONFIGURED });
  });
});
