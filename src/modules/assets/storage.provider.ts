import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '@/common/clock/clock.port';
import { GcsAdapter } from './gcs.adapter';
import { StoragePort } from './storage.port';
import { UnconfiguredStorage } from './unconfigured-storage';

/**
 * **Which storage this instance has** (P18.7-T2, ADR-0153, D12): the bucket when `GCS_BUCKET` names one, and
 * otherwise — in development and test only — storage that refuses every call with `STORAGE_NOT_CONFIGURED`.
 *
 * `env.validation.ts` already refuses to boot staging or production without a bucket; the throw below is the same
 * rule held again where the choice is made, so a configuration that bypassed validation cannot quietly run a
 * deployed API with uploads switched off.
 */
export function storageFor(config: ConfigService, clock: Clock): StoragePort {
  // Trimmed here as well as in validation: `ConfigService.get` falls back to the raw `process.env` when the
  // validated value is unset, so a blank `GCS_BUCKET="  "` would otherwise arrive here as truthy.
  if (config.get<string>('GCS_BUCKET')?.trim()) return new GcsAdapter(config, clock);
  const environment = config.get<string>('NODE_ENV');
  if (environment === 'development' || environment === 'test') return new UnconfiguredStorage();
  throw new Error(`GCS_BUCKET is required when NODE_ENV is ${environment ?? 'unset'}: a deployed API always has storage.`);
}

/** The `StoragePort` binding `app.module.ts` registers. */
export const STORAGE_PROVIDER: Provider = {
  provide: StoragePort,
  inject: [ConfigService, Clock],
  useFactory: storageFor,
};
