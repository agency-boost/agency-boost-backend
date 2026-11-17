import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeProductDataReader } from './claude-reader';
import {
  PRODUCT_DATA_READER, ProductDataReader, type FileReadingInput, type IllustrationReadingInput, type ReadingResult,
} from './reader.port';
import type { FileReading, IllustrationReading } from './reading-schema';

/**
 * **No key, no reading** (ADR-0259 §6): the reader a deployment without `ANTHROPIC_API_KEY` has. It says so, the screens
 * disable *Unggah file* and the illustration's upload with one line of reason, and nothing is sent anywhere. The
 * premium table's own Excel/CSV upload (ADR-0258) reads no AI and still works.
 */
export class UnconfiguredProductDataReader extends ProductDataReader {
  get enabled(): boolean {
    return false;
  }

  async readFile(_input: FileReadingInput): Promise<ReadingResult<FileReading>> {
    return { ok: false, failure: 'not_configured', usage: null };
  }

  async condenseIllustration(_input: IllustrationReadingInput): Promise<ReadingResult<IllustrationReading>> {
    return { ok: false, failure: 'not_configured', usage: null };
  }
}

/** The reader the environment chooses: Claude with a key, the refusal without one. The key is read here and nowhere else. */
export function readerFor(config: Pick<ConfigService, 'get'>): ProductDataReader {
  const key = config.get<string>('ANTHROPIC_API_KEY');
  const model = config.get<string>('ANTHROPIC_MODEL') ?? 'claude-opus-5-5';
  return key ? new ClaudeProductDataReader(key, model) : new UnconfiguredProductDataReader();
}

export const PRODUCT_DATA_READER_PROVIDER: Provider = {
  provide: PRODUCT_DATA_READER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => readerFor(config),
};
