import Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '@/config/env.validation';
import { ClaudeProductDataReader, failureOf } from './claude-reader';
import { readerFor, UnconfiguredProductDataReader } from './reader.provider';
import type { FileReadingInput } from './reader.port';

/**
 * **P19.15-T3 AC-5 — the reading through Claude, with the SDK faked** (ADR-0259 §6). No test calls the real API: a fake
 * client stands where `new Anthropic()` would, and records what the request would have carried.
 */

const input: FileReadingInput = {
  file: { kind: 'pdf', name: 'tarif.pdf', base64: 'JVBERi0xLjQK' },
  company: { id: 'c1', name: 'Prudential' },
  companies: [{ id: 'c1', name: 'Prudential' }],
  catalogue: [],
  today: '2026-11-12',
};

const good = { items: [], notes: 'Brosur saja.' };

function fake(answer: () => Promise<Record<string, unknown>>) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (body: Record<string, unknown>) => {
          sent.push(body);
          return { finalMessage: answer };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

const message = (over: Record<string, unknown>) => async () => ({
  model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 300 }, parsed_output: good, ...over,
});

describe('P19.15-T3 the Claude reader (ai/claude-reader.ts)', () => {
  it('streams one structured-output request per file: the model, adaptive thinking, the refusal fallback, the PDF first', async () => {
    const { client, sent } = fake(message({}));
    const reader = new ClaudeProductDataReader('sk-ant-test', 'claude-opus-5-5', client);
    const result = await reader.readFile(input);

    expect(result).toEqual({ ok: true, value: good, usage: { inputTokens: 1200, outputTokens: 300, model: 'claude-opus-5-5' } });
    const body = sent[0];
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect((body.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    const content = (body.messages as { content: { type: string }[] }[])[0].content;
    expect(content.map((b) => b.type)).toEqual(['document', 'text']);
    expect(String(body.system)).toContain('Take a number ONLY exactly as it is written in the file');
  });

  it('sends a picture as an image and a workbook as text', async () => {
    const { client, sent } = fake(message({}));
    const reader = new ClaudeProductDataReader('sk-ant-test', 'claude-opus-5-5', client);
    await reader.readFile({ ...input, file: { kind: 'image', name: 'foto.jpg', base64: '/9j/', mediaType: 'image/jpeg' } });
    await reader.readFile({ ...input, file: { kind: 'text', name: 'tarif.xlsx', text: '1 | A=Usia', format: 'grid' } });
    const blocks = sent.map((b) => (b.messages as { content: { type: string; text?: string }[] }[])[0].content);
    expect(blocks[0][0].type).toBe('image');
    expect(blocks[1][0]).toMatchObject({ type: 'text', text: expect.stringContaining('<file name="tarif.xlsx" format="grid">') });
  });

  it('reads the stop reason before the content: a refusal and a cut-off answer are failures, not data', async () => {
    const refused = new ClaudeProductDataReader('k', 'claude-opus-5-5', fake(message({ stop_reason: 'refusal', parsed_output: null })).client);
    expect(await refused.readFile(input)).toMatchObject({ ok: false, failure: 'refused' });
    const cut = new ClaudeProductDataReader('k', 'claude-opus-5-5', fake(message({ stop_reason: 'max_tokens' })).client);
    expect(await cut.readFile(input)).toMatchObject({ ok: false, failure: 'too_long' });
    const wrong = new ClaudeProductDataReader('k', 'claude-opus-5-5', fake(message({ parsed_output: { items: 'nope' } })).client);
    expect(await wrong.readFile(input)).toMatchObject({ ok: false, failure: 'unreadable' });
  });

  it('names a thrown SDK error by its class, never by its message', async () => {
    const headers = new Headers();
    expect(failureOf(new Anthropic.AuthenticationError(401, {}, 'bad key', headers))).toBe('key_refused');
    expect(failureOf(new Anthropic.RateLimitError(429, {}, 'slow down', headers))).toBe('busy');
    expect(failureOf(new Anthropic.InternalServerError(529, {}, 'overloaded', headers))).toBe('busy');
    expect(failureOf(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
    expect(failureOf(new Anthropic.BadRequestError(400, {}, 'too many pages', headers))).toBe('file_refused');
    expect(failureOf(new Error('anything'))).toBe('service_error');
    const thrown = new ClaudeProductDataReader('k', 'claude-opus-5-5', fake(async () => { throw new Anthropic.RateLimitError(429, {}, 'x', headers); }).client);
    expect(await thrown.readFile(input)).toEqual({ ok: false, failure: 'busy', usage: null });
  });
});

describe('P19.15-T3 AC-5 without the key, reading is off and says so', () => {
  it('chooses Claude with a key and the refusal without one', async () => {
    const without = readerFor({ get: () => undefined } as unknown as ConfigService);
    expect(without).toBeInstanceOf(UnconfiguredProductDataReader);
    expect(without.enabled).toBe(false);
    expect(await without.readFile(input)).toEqual({ ok: false, failure: 'not_configured', usage: null });
    const withKey = readerFor({ get: (k: string) => (k === 'ANTHROPIC_API_KEY' ? 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' : undefined) } as unknown as ConfigService);
    expect(withKey).toBeInstanceOf(ClaudeProductDataReader);
    expect(withKey.enabled).toBe(true);
  });

  it('accepts the key only in its shape, and defaults the model to claude-opus-5-5', () => {
    const base = {
      MONGODB_URI: 'mongodb://localhost/x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32),
      MAIL_FROM: 'AgencyBoost <no-reply@agencyboost.id>', MAIL_PROVIDER: 'log',
    };
    expect(validateEnv(base).ANTHROPIC_API_KEY).toBeUndefined();
    expect(validateEnv({ ...base, ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(validateEnv(base).ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(validateEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }).ANTHROPIC_API_KEY).toBe('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(() => validateEnv({ ...base, ANTHROPIC_API_KEY: '"sk-ant-api03-abcdefghijklmnopqrstuvwxyz"' })).toThrow(/ANTHROPIC_API_KEY: is not an Anthropic API key/);
    expect(() => validateEnv({ ...base, ANTHROPIC_MODEL: 'gpt-4' })).toThrow(/ANTHROPIC_MODEL/);
  });
});
