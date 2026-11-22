import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { INTAKE } from '@/domain/constants';
import {
  ProductDataReader, type FileReadingInput, type IllustrationReadingInput, type ReadablePart, type ReadingFailure,
  type ReadingResult, type ReadingUsage,
} from './reader.port';
import {
  FILE_SYSTEM_PROMPT, fileInstruction, ILLUSTRATION_SYSTEM_PROMPT, illustrationInstruction,
} from './reading-prompts';
import {
  fileReadingSchema, illustrationReadingSchema, type FileReading, type IllustrationReading,
} from './reading-schema';

/**
 * **The reading, through Anthropic's Claude API** (P19.15-T2, T3; ADR-0259 §6) — the official SDK, `@anthropic-ai/sdk`.
 *
 * - **One call per file**, streamed (`client.beta.messages.stream` and `finalMessage()`): a long table's answer is long,
 *   and a stream is never cut by an HTTP timeout. Structured output (`output_config.format`, from the zod schema with the
 *   SDK's `betaZodOutputFormat`) makes the answer JSON of exactly our shape; it is parsed again here before it is used.
 * - **Claude Opus 5.5 by default** (`ANTHROPIC_MODEL`), adaptive thinking, effort `high`: reading a rate table right is
 *   intelligence-sensitive work, and a wrong reading costs more than the tokens.
 * - **The server-side refusal fallback is on** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`), as the
 *   SDK guidance asks of every Claude Opus 5.5 caller: a request a safety classifier declines is re-run on Anthropic's
 *   recommended model for that category, in the same call. A refusal that survives it is reported as `refused`.
 * - **Every stop reason is read before the content**: `refusal` → `refused`, `max_tokens` → `too_long`; an answer that
 *   does not parse → `unreadable`. **The SDK's typed errors** decide the rest: a refused key, a rate limit or an overload
 *   (`busy`), a timeout, a file the API refused (too many pages, too large), anything else. The SDK retries a 408, 409,
 *   429, 5xx and a lost connection itself (`INTAKE.AI_MAX_RETRIES`), each attempt bounded by `INTAKE.AI_TIMEOUT_MS`.
 * - **Never logged**: the key, the file, the answer. A failure logs its kind, the model and the token counts only.
 */
export class ClaudeProductDataReader extends ProductDataReader {
  private readonly logger = new Logger(ClaudeProductDataReader.name);
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string, client?: Anthropic) {
    super();
    this.client = client ?? new Anthropic({ apiKey, timeout: INTAKE.AI_TIMEOUT_MS, maxRetries: INTAKE.AI_MAX_RETRIES });
  }

  get enabled(): boolean {
    return true;
  }

  readFile(input: FileReadingInput): Promise<ReadingResult<FileReading>> {
    return this.read(
      FILE_SYSTEM_PROMPT,
      input.file,
      fileInstruction({ ...input, fileName: input.file.name }),
      fileReadingSchema,
    );
  }

  condenseIllustration(input: IllustrationReadingInput): Promise<ReadingResult<IllustrationReading>> {
    return this.read(
      ILLUSTRATION_SYSTEM_PROMPT,
      input.file,
      illustrationInstruction({ ...input, fileName: input.file.name }),
      illustrationReadingSchema,
    );
  }

  /** The file as content blocks, before the instruction: a PDF as a document, a picture as an image, the rest as text. */
  private contentOf(part: ReadablePart, instruction: string): Anthropic.Beta.BetaContentBlockParam[] {
    const instructionBlock: Anthropic.Beta.BetaTextBlockParam = { type: 'text', text: instruction };
    switch (part.kind) {
      case 'pdf':
        return [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: part.base64 }, title: part.name },
          instructionBlock,
        ];
      case 'image':
        return [{ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.base64 } }, instructionBlock];
      case 'text':
        return [
          { type: 'text', text: `<file name="${part.name}" format="${part.format}">\n${part.text}\n</file>` },
          instructionBlock,
        ];
    }
  }

  private async read<S extends z.ZodType>(
    system: string, part: ReadablePart, instruction: string, schema: S,
  ): Promise<ReadingResult<z.infer<S>>> {
    let usage: ReadingUsage | null = null;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: INTAKE.AI_MAX_TOKENS,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: this.contentOf(part, instruction) }],
      });
      const message = await stream.finalMessage();
      usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: message.model };

      if (message.stop_reason === 'refusal') return this.failed('refused', usage);
      if (message.stop_reason === 'max_tokens') return this.failed('too_long', usage);
      const checked = schema.safeParse(message.parsed_output);
      if (!checked.success) return this.failed('unreadable', usage);
      return { ok: true, value: checked.data as z.infer<S>, usage };
    } catch (err) {
      return this.failed(failureOf(err), usage);
    }
  }

  private failed(failure: ReadingFailure, usage: ReadingUsage | null): { ok: false; failure: ReadingFailure; usage: ReadingUsage | null } {
    this.logger.warn({ failure, model: usage?.model ?? this.model, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens }, 'product data reading failed');
    return { ok: false, failure, usage };
  }
}

/** **A thrown error, as a failure a card can name** — most specific class first; never its message, which may quote input. */
export function failureOf(err: unknown): ReadingFailure {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'key_refused';
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return 'busy';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) return 'file_refused';
  if (err instanceof Anthropic.APIError) return 'service_error';
  // The SDK's parse of a structured answer that is not JSON of the schema.
  if (err instanceof SyntaxError) return 'unreadable';
  return 'service_error';
}
