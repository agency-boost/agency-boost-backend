import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESPONSE_SHAPES } from './common/api/response-map';

interface Operation {
  operationId?: string;
  responses: Record<string, { content?: unknown }>;
  description?: string;
  'x-required-permission'?: string;
}

const document = JSON.parse(
  readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, unknown> } };

const HTTP = ['get', 'post', 'patch', 'put', 'delete'];
const operations = Object.entries(document.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => HTTP.includes(method))
    .map(([method, op]) => ({ label: `${method.toUpperCase()} ${path}`, path, op })),
);

/**
 * P3.5-T11. The document listed every route and described none of their answers: a
 * generated client typed every response `any`, and the whole authorisation model was
 * invisible.
 *
 * These read the **committed** `openapi.json`, which CI already checks is in step with
 * the code. So a route added without a response shape fails here rather than shipping a
 * contract that says nothing — which is what makes "every operation" a rule instead of a
 * hope.
 */
describe('the OpenAPI document describes the API', () => {
  it('is not empty, so a stale file cannot make the rest of these vacuous', () => {
    expect(operations.length).toBeGreaterThan(60);
  });

  it('AC-1: every operation documents its success body', () => {
    const missing = operations
      .filter(({ op }) => !('204' in op.responses))
      .filter(({ op }) =>
        !Object.entries(op.responses).some(([code, r]) => code.startsWith('2') && r.content),
      )
      .map(({ label }) => label);
    expect(missing).toEqual([]);
  });

  it('AC-1: every operation has an entry in the response table', () => {
    // The table is the single place completeness is visible. A handler added without one
    // would otherwise be silently undocumented.
    const missing = operations
      .map(({ label, op }) => [label, op.operationId?.replace(/_v\d+$/, '')] as const)
      .filter(([, key]) => !key || !(key in RESPONSE_SHAPES))
      .map(([label]) => label);
    expect(missing).toEqual([]);
  });

  it('AC-1: the table names no operation that does not exist', () => {
    const live = new Set(operations.map(({ op }) => op.operationId?.replace(/_v\d+$/, '')));
    expect(Object.keys(RESPONSE_SHAPES).filter((k) => !live.has(k))).toEqual([]);
  });

  it('AC-2: every operation documents its failures with the shared envelope', () => {
    const envelope = '#/components/schemas/ApiErrorEnvelope';
    for (const { label, op } of operations) {
      const failures = Object.entries(op.responses).filter(([code]) => code.startsWith('4') || code.startsWith('5'));
      expect([label, failures.length > 0]).toEqual([label, true]);
      for (const [code, response] of failures) {
        const schema = (response.content as Record<string, { schema?: { $ref?: string } }> | undefined)?.[
          'application/json'
        ]?.schema;
        expect([label, code, schema?.$ref]).toEqual([label, code, envelope]);
      }
    }
  });

  it('AC-2: every operation can fail with INTERNAL_ERROR, because anything can', () => {
    expect(operations.filter(({ op }) => !('500' in op.responses)).map((o) => o.label)).toEqual([]);
  });

  it('AC-3: every operation says what it needs — a permission, or that any session will do', () => {
    // Three answers are acceptable and a fourth — silence — is not. Public routes carry
    // no 401; everything else either names a permission or says a session is the gate.
    const silent = operations
      .filter(({ op }) => '401' in op.responses)
      .filter(({ op }) => !op['x-required-permission'] && !op.description?.includes('Any signed-in user'))
      .map(({ label }) => label);
    expect(silent).toEqual([]);
  });

  it('AC-3: a permissioned operation documents the refusal that goes with it', () => {
    const missing = operations
      .filter(({ op }) => op['x-required-permission'] && !('403' in op.responses))
      .map(({ label }) => label);
    expect(missing).toEqual([]);
  });

  it('AC-5: the two known inaccuracies stay fixed', () => {
    const refresh = document.paths['/api/v1/auth/refresh'].post as Operation & {
      requestBody?: { required?: boolean };
    };
    const logout = document.paths['/api/v1/auth/logout'].post as Operation & {
      requestBody?: { required?: boolean };
    };
    // The token normally arrives in a cookie; the body is the fallback. Marked required,
    // a generated client would refuse to call these without one it does not have.
    expect(refresh.requestBody?.required).toBe(false);
    expect(logout.requestBody?.required).toBe(false);

    // A POST defaults to 201 and this one answers 200 — it ends a session rather than
    // creating anything.
    expect(Object.keys(document.paths['/api/v1/admin/impersonate/end'].post.responses)).toContain('200');
    expect(Object.keys(document.paths['/api/v1/admin/impersonate/end'].post.responses)).not.toContain('201');
  });

  /**
   * 2026-10-01, the Phase 10.1 exit. ADR-0062 §3: a customer string names no phase, and an
   * OpenAPI description is one — Swagger serves the document at `/api/docs` outside production.
   * Twenty-three summaries and descriptions carried a task id in parentheses, which
   * `check-docs.py` already counts as naming a phase in a manual. This walks the **whole**
   * document rather than the operations alone, because a DTO's `description` lives under
   * `components.schemas`, which is where most of them were.
   */
  it('names no phase in any summary, description, title or example (ADR-0062 §3)', () => {
    const NAMES_A_PHASE = /\bP\d+(?:\.\d+)?-T\d+\b|\bphases?\s+\d|\blater\s+phase\b/i;
    const SERVED = new Set(['summary', 'description', 'title', 'example', 'examples']);
    const offending: string[] = [];

    // Every string under a served key counts — an `example` may be an object.
    const strings = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        const hit = NAMES_A_PHASE.exec(node);
        if (hit) {
          const from = Math.max(0, hit.index - 30);
          offending.push(`${path}: …${node.slice(from, hit.index + hit[0].length + 10)}…`);
        }
      } else if (Array.isArray(node)) {
        node.forEach((item, i) => strings(item, `${path}[${i}]`));
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) strings(value, `${path}.${key}`);
      }
    };
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (SERVED.has(key)) strings(value, `${path}.${key}`);
          else walk(value, `${path}.${key}`);
        }
      }
    };

    walk(document, '$');
    expect(offending).toEqual([]);
  });

  it('a 404 is described as indistinguishable from another tenant, wherever it appears', () => {
    // The invariant that makes cross-tenant probing useless. If the document explained it
    // on some routes and not others, an integrator would reasonably read the difference
    // as meaningful.
    for (const { label, op } of operations) {
      const notFound = op.responses['404'] as { description?: string } | undefined;
      if (!notFound) continue;
      expect([label, notFound.description?.includes('another office')]).toEqual([label, true]);
    }
  });

  /*
   * `openapi.ts` derives a 400 from a documented body or query parameter. The roster's query DTO is
   * empty on purpose, so nothing derives one, and the document said the read could not be refused
   * while the server refused `?membershipId=` and `?page=` by name. The handler writes it instead.
   */
  it('P11-T6 AC-2 the roster documents the 400 its empty query answers, which no parameter derives', () => {
    const roster = document.paths['/api/v1/coaching/coachees'].get;
    expect(roster.responses).toHaveProperty('400');
    expect((roster.responses['400'] as { description?: string }).description).toMatch(/^`VALIDATION_FAILED`/);
  });
});
