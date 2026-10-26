import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartFromDto } from './named-template.dto';

/** The properties a body is refused for, by the rules `POST /admin/tenants` applies to `startFrom`. */
async function refused(body: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(StartFromDto, body), { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property).sort();
}

const ID = '66f0000000000000000000c1';

/**
 * **P18.9-T3 AC-5 — *Start from* the Template library, as the API takes it** (ADR-0164 §5): `templateLibrary`
 * with `kind: template` names the library's template, its default when `templateId` is absent; without it a
 * template is still the company's own and must be named.
 */
describe('P18.9-T3 StartFromDto — the Template library', () => {
  it('AC-5 takes the library’s default, and one of its templates by id', async () => {
    expect(await refused({ kind: 'template', templateLibrary: true })).toEqual([]);
    expect(await refused({ kind: 'template', templateLibrary: true, templateId: ID })).toEqual([]);
  });

  it('AC-5 still needs a company template named without it, and a well-formed id with it', async () => {
    expect(await refused({ kind: 'template' })).toEqual(['templateId']);
    expect(await refused({ kind: 'template', templateLibrary: false })).toEqual(['templateId']);
    expect(await refused({ kind: 'template', templateLibrary: true, templateId: 'not-an-id' })).toEqual(['templateId']);
  });

  it('AC-5 refuses a flag that is not a boolean', async () => {
    expect(await refused({ kind: 'template', templateLibrary: 'yes', templateId: ID })).toEqual(['templateLibrary']);
  });

  it('leaves the other sources as they were', async () => {
    expect(await refused({ kind: 'defaults' })).toEqual([]);
    expect(await refused({ kind: 'empty' })).toEqual([]);
    expect(await refused({ kind: 'template', templateId: ID })).toEqual([]);
  });
});
