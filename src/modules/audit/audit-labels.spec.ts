import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readerIn } from '@/common/i18n/reader';
import { actionLabel, LABELLED_ACTIONS, sectionLabel, targetKindLabel } from './audit-labels.messages';

/**
 * **P19.4-T3 AC-11 (SA UI-016): every action the API records has a label.** The tree is read for the actions it writes —
 * in the files that write the log (`.record(`, `recordMany(`, `audited(`, an `*AuditAction*` type, a `targetCollection`)
 * every `'resource.verb'` literal — and each must be labelled, or named here as not an action, with why. So a new action
 * cannot reach `/admin/audit` as its code.
 */
const SRC = join(__dirname, '../..');

/** Literals of the action's shape, in those files, that are not actions. Each says what it is. */
const NOT_ACTIONS = new Map<string, string>([
  ['a.b', 'a seed comment’s example of a dotted path'],
  ['after.field', 'a filter on the change a seed row records'],
  ['after.fields', 'a filter on the change a seed row records'],
  ['after.kind', 'a filter on the change a seed row records'],
  ['after.slot', 'a filter on the change a seed row records'],
  ['after.month', 'a filter on the change a row records'],
  ['after.surface', 'a filter on the change a row records'],
  ['commitments.month', 'a lead’s field path in the demo seed'],
  ['discount.percent', 'a quote’s field, named by a refusal (`billing/price-quote.ts`)'],
  ['kpm.owner_failed', 'why a half-made KPM was undone, written in `kpm.discarded`’s `after.why`'],
  ['owner.email', 'a field `POST /admin/tenants` refuses, named in `details.field`'],
  ['it.code', 'a field path in the activation service'],
  ['it.source', 'a field path in the activation service'],
  ['kpm.provisioned', 'the OpenAPI example of an action, in a response DTO'],
  ['origin.kind', 'a named template’s field path'],
  ['overrides.description', 'an office product override’s field path'],
  ['overrides.objections', 'an office product override’s field path'],
  ['overrides.faq', 'an office product override’s field path (P19.7-T1, ADR-0225 §5)'],
  ['client.name', 'a proposal’s field path, searched by Riwayat (`proposals/proposal.service.ts`)'],
  ['logo.png', 'a branding image’s file name (`branding/branding.service.ts`, P19.6-T1)'],
  ['mascot.default', 'a branding field path a refusal names (`branding/branding.service.ts`, P19.6-T1)'],
]);

/** Actions written by a template literal, which a literal search cannot see: `kpm.${status}` over `SetStatusDto`'s values. */
const TEMPLATED = ['kpm.active', 'kpm.suspended', 'kpm.archived'];

/**
 * The actions other parts of P19.4-T3 record (the split's contract): labelled before their code lands, so the page reads
 * them in words from their first row.
 */
const P19_4_T3 = [
  'platform_read.members', 'platform_read.kpm_comparison', 'platform_read.kpm_analytics', 'platform_read.kpm_data',
  'platform_read.company_kpms', 'billing.quote_sent', 'kpm.owner_invited', 'kpm.pending_owner_set',
];

function recordedActions(): Set<string> {
  const found = new Set<string>();
  const files = globSync('**/*.ts', { cwd: SRC }).filter((f) => !f.endsWith('.spec.ts') && !f.includes('audit-labels'));
  for (const file of files) {
    const text = readFileSync(join(SRC, file), 'utf8');
    if (!/\.record(Many)?\(|\baudited\(|AuditAction|targetCollection/.test(text)) continue;
    for (const [, literal] of text.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)) found.add(literal);
  }
  return found;
}

describe('the audit log in words (P19.4-T3 AC-11; SA UI-016)', () => {
  const found = recordedActions();

  it('finds the actions the tree records at all, so a silent zero cannot pass', () => {
    expect(found.size).toBeGreaterThan(150);
    expect(found).toContain('company_template.draft_saved');
  });

  it('P19.4-T3 AC-11 labels every action the API records, in both languages', () => {
    const labelled = new Set(LABELLED_ACTIONS);
    const missing = [...found, ...TEMPLATED, ...P19_4_T3]
      .filter((action) => !labelled.has(action) && !NOT_ACTIONS.has(action))
      .sort();
    expect(missing).toEqual([]);
  });

  it('names as not an action only literals that are not labelled, and that the tree still holds', () => {
    for (const [literal, why] of NOT_ACTIONS) {
      expect(LABELLED_ACTIONS).not.toContain(literal);
      expect(why.length).toBeGreaterThan(10);
    }
  });

  it('P19.4-T3 AC-11 reads a template draft’s save as SA UI-016 writes it', () => {
    expect(actionLabel('company_template.draft_saved', readerIn('id'))).toBe('Draf template disimpan');
    expect(actionLabel('company_template.draft_saved', readerIn('en'))).toBe('Template draft saved');
    // The pre-ADR-0023 rows keep their words in the log, and read as their new name's.
    expect(actionLabel('platform_template.draft_saved', readerIn('id'))).toBe('Draf template disimpan');
  });

  it('P19.4-T3 AC-11 names the KPM a platform read looked at, as ADR-0207 §5 has it', () => {
    expect(actionLabel('platform_read.members', readerIn('id'))).toBe('Daftar anggota dilihat');
    expect(actionLabel('platform_read.kpm_analytics', readerIn('id'), '0417')).toBe('Analytics KPM 0417 dilihat');
    expect(actionLabel('platform_read.kpm_analytics', readerIn('id'), null)).toBe('Analytics KPM dilihat');
    expect(actionLabel('platform_read.kpm_data', readerIn('en'), '0417')).toBe('KPM 0417 monthly data viewed');
  });

  it('answers an action nobody labelled as it was recorded, rather than a blank', () => {
    expect(actionLabel('something.new', readerIn('id'))).toBe('something.new');
  });

  it('P19.4-T3 AC-11 names the kind of target and a template section, by collection and by kind', () => {
    expect(targetKindLabel('products', readerIn('id'))).toBe('Produk');
    expect(targetKindLabel('companyTemplates', readerIn('id'))).toBe('Bagian template');
    expect(targetKindLabel('unknownThings', readerIn('id'))).toBe('unknownThings');
    expect(sectionLabel('activity_taxonomy', readerIn('id'))).toBe('Aktivitas & rasio');
    expect(sectionLabel('ratio_set', readerIn('en'))).toBe('Activities & ratios');
    expect(sectionLabel('nothing', readerIn('id'))).toBeNull();
  });
});
