import { DomainException } from '@/common/errors/domain.exception';
import { decodeCursor, encodeCursor } from '@/common/pagination/cursor';
import { AUDIT_LOG } from '@/domain/constants';
import { readerIn } from '@/common/i18n/reader';
import { AuditReadService } from './audit-read.service';

const KPM = '66f0000000000000000000a1';
const CO = '66f0000000000000000000c1';
const ROOT = '66f0000000000000000000e1';
const OWNER = '66f0000000000000000000e2';
const MEM = '66f0000000000000000000d1';
/** The person reading the log: an Owner, say, who is also an AB somebody above them coaches. */
const READER = '66f0000000000000000000e3';
/** Two of the reader's memberships — one now, one from before they left and rejoined — and somebody else's. */
const READER_NOW = '66f0000000000000000000d2';
const READER_BEFORE = '66f0000000000000000000d3';
const SOMEBODY = '66f0000000000000000000d4';

const T0 = new Date('2026-11-02T16:10:00Z').getTime();
const MINUTE = 60_000;

let seq = 0;
/** A row id that sorts after every id made before it, as a Mongo ObjectId does. */
const nextId = () => (0x6a000000 + (seq += 1)).toString(16).padStart(24, '0');

/** A row as `findNewestFirst` hands it back: a Mongoose document, read by field. */
const row = (over: Record<string, unknown> = {}) => ({
  _id: nextId(),
  createdAt: new Date('2026-09-24T02:00:00Z'),
  action: 'kpm.suspended',
  targetCollection: 'kpms',
  targetId: KPM,
  actorUserId: ROOT,
  effectiveUserId: null,
  before: null,
  after: null,
  ...over,
});

/** A row written `minutesAgo` before `T0`. */
const at = (minutesAgo: number, over: Record<string, unknown> = {}) =>
  row({ createdAt: new Date(T0 - minutesAgo * MINUTE), ...over });

/** A model double whose `find({_id:{$in}})` answers from a fixed list. */
const model = (rows: Record<string, unknown>[]) => ({
  find: (filter: { _id: { $in: string[] } }) => ({
    lean: () => ({
      exec: async () => rows.filter((r) => filter._id.$in.includes(String(r._id))),
    }),
  }),
});

/**
 * `AuditService`'s two reads over a fixed log: newest first with ties broken by id, resumed past `after`, `limit` at a
 * time — the order and the cursor the real one keeps. The filter is the database's to apply, and the integration
 * spec's to prove; here every row is in the reach.
 */
function logOf(rows: ReturnType<typeof row>[]) {
  const ordered = [...rows].sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (b._id < a._id ? -1 : b._id > a._id ? 1 : 0));
  return {
    findNewestFirst: jest.fn(async (_kpmId: string | null, _filter: unknown, after: { at: Date; id: string } | null, limit: number) => {
      const past = after
        ? ordered.filter((r) => r.createdAt < after.at || (r.createdAt.getTime() === after.at.getTime() && r._id < after.id))
        : ordered;
      return past.slice(0, limit);
    }),
    distinctWithin: jest.fn(async (_kpmId: string | null, key: 'action' | 'actorUserId') =>
      [...new Set(ordered.map((r) => String(r[key])))]),
  };
}

/** The names P19.4-T3 AC-11 reads: a template, its section rows, products, rungs and KPM requests. */
interface Named {
  templates?: Record<string, unknown>[];
  sections?: Record<string, unknown>[];
  products?: Record<string, unknown>[];
  rungs?: Record<string, unknown>[];
  requests?: Record<string, unknown>[];
  offices?: Record<string, unknown>[];
}

/** A product model double: by id, as `model` answers, and by code. */
const productModel = (rows: Record<string, unknown>[]) => ({
  find: (filter: { _id?: { $in: string[] }; code?: { $in: string[] } }) => ({
    lean: () => ({
      exec: async () => rows.filter((r) => (filter._id
        ? filter._id.$in.includes(String(r._id))
        : (filter.code?.$in ?? []).includes(String(r.code)))),
    }),
  }),
});

function make(rows: ReturnType<typeof row>[], memberships: unknown[] = [], named: Named = {}) {
  const audit = logOf(rows);
  const members = {
    byIdsAnywhereForAudit: jest.fn(async (ids: string[]) =>
      (memberships as { _id: string }[]).filter((m) => ids.includes(m._id))),
  };
  const kpms = {
    ...model([{ _id: KPM, code: '0417', branchName: 'Surabaya Branch', companyId: CO }, ...(named.offices ?? [])]),
    findById: () => ({ lean: () => ({ exec: async () => ({ timezone: 'Asia/Jakarta' }) }) }),
  };
  const service = new AuditReadService(
    audit as never,
    model([
      { _id: ROOT, fullName: 'Root Operator' },
      { _id: OWNER, fullName: 'Rangga Wibisono' },
    ]) as never,
    members as never,
    kpms as never,
    model([{ _id: CO, name: 'Prudential' }]) as never,
    model(named.templates ?? []) as never,
    model(named.sections ?? []) as never,
    productModel(named.products ?? []) as never,
    model(named.rungs ?? []) as never,
    model(named.requests ?? []) as never,
  );
  return { service, audit, members };
}

const platform = (reader = READER) => ({ kpmId: null, readerUserId: reader });

/** The groups of one page, oldest-first ids aside: what the screen draws. */
const shape = (items: { action: string; count: number }[]) => items.map((g) => `${g.action}×${g.count}`);

/**
 * Reading the audit log with the people and the things named (client feedback, 2026-09-24).
 *
 * Every row said `memberships 68f3c1a9…`, so answering *"who suspended Surabaya?"* meant three
 * lookups in a database shell — which is the question this screen exists to answer.
 */
describe('AuditReadService — names', () => {
  it('names the actor and the office', async () => {
    const { service } = make([row()]);

    const { items: [entry] } = await service.page(platform(), {});

    expect(entry).toMatchObject({
      actorName: 'Root Operator',
      targetLabel: 'KPM 0417 · Surabaya Branch',
      targetId: KPM,
      count: 1,
    });
  });

  it('names both people for an impersonated action', async () => {
    // Under impersonation both are recorded. Naming only one would attribute the action to
    // the wrong person.
    const { service } = make([row({ effectiveUserId: OWNER })]);

    const { items: [entry] } = await service.page(platform(), {});

    expect(entry).toMatchObject({ actorName: 'Root Operator', effectiveName: 'Rangga Wibisono' });
  });

  it('names a company', async () => {
    const { service } = make([row({ targetCollection: 'companies', targetId: CO })]);

    expect((await service.page(platform(), {})).items[0].targetLabel).toBe('Prudential');
  });

  it('names a membership through the person it belongs to', async () => {
    const { service } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: 'AG-1' }],
    );

    expect((await service.page(platform(), {})).items[0].targetLabel).toBe('Rangga Wibisono · AG-1');
  });

  it('reads memberships through the repository’s named cross-tenant method', async () => {
    // Invariant §1: a Super Admin's cross-tenant read is an explicitly named method, never
    // an absent filter. `repositories.tenancy.spec.ts` enforces the other half.
    const { service, members } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: null }],
    );

    await service.page(platform(), {});

    expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith([MEM]);
  });

  it('keeps the id when nothing names it', async () => {
    // A collection nobody has taught the resolver about is *this is all we know*, not
    // *nothing happened* — so the screen is given the id rather than a blank.
    const { service } = make([row({ targetCollection: 'goals', targetId: 'g-9' })]);

    const { items: [entry] } = await service.page(platform(), {});

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'g-9' });
  });

  it('survives an id that is not an ObjectId, rather than failing the page', async () => {
    // `$in` throws a CastError on a malformed id, which would take every row down with it.
    const { service } = make([row({ targetCollection: 'kpms', targetId: 'not-an-id' })]);

    const { items: [entry] } = await service.page(platform(), {});

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'not-an-id' });
  });

  it('carries the mutation through unchanged', async () => {
    const { service } = make([row({ before: { status: 'active' }, after: { status: 'suspended' } })]);

    const { items: [entry] } = await service.page(platform(), {});

    expect(entry).toMatchObject({
      before: { status: 'active' }, after: { status: 'suspended' },
    });
  });

  it('asks each collection once, however many rows name it', async () => {
    // A page costs a handful of reads, not one per row.
    const { service, audit } = make([
      row({ actorUserId: ROOT }), row({ actorUserId: OWNER }), row({ actorUserId: ROOT, action: 'kpm.reactivated' }),
    ]);

    const { items } = await service.page(platform(), {});

    expect(items).toHaveLength(3);
    expect(audit.findNewestFirst).toHaveBeenCalledTimes(1);
    expect(items.every((r) => r.targetLabel === 'KPM 0417 · Surabaya Branch')).toBe(true);
  });
});

const TPL = '66f0000000000000000000f1';
const SECTION = '66f0000000000000000000f2';
const PRODUCT = '66f0000000000000000000f3';
const RUNG = '66f0000000000000000000f4';
const REQUEST = '66f0000000000000000000f5';
const OTHER_KPM = '66f0000000000000000000a2';
const OTHER_CO = '66f0000000000000000000c2';

/**
 * **P19.4-T3 AC-11 (SA UI-016; SA case 9): names instead of ids, and actions in words.** The target is named by what it
 * is — a template's section, a product, a rung, a KPM request, an office's own record by its member — read once per
 * collection whatever the page's length, deleted rows included.
 */
describe('AuditReadService — P19.4-T3 AC-11 names and labels', () => {
  const id = { kpmId: null, readerUserId: READER, reader: readerIn('id') };
  const en = { kpmId: null, readerUserId: READER, reader: readerIn('en') };

  it('P19.4-T3 AC-11 names a template section as “<template> · <section>”, from the row’s own change', async () => {
    const { service } = make(
      [row({ action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: SECTION,
        after: { companyId: CO, templateId: TPL, kind: 'activity_taxonomy', revision: 3, version: 2 } })],
      [],
      { templates: [{ _id: TPL, name: 'Prudential template' }] },
    );

    const { items: [entry] } = await service.page(id, {});

    expect(entry).toMatchObject({
      actionLabel: 'Draf template disimpan',
      targetKind: 'Bagian template',
      targetLabel: 'Prudential template · Aktivitas & rasio',
    });
  });

  it('P19.4-T3 AC-11 names a section from its own row where the audit row carries no change', async () => {
    const { service } = make(
      [row({ action: 'company_template.published', targetCollection: 'companyTemplates', targetId: SECTION, after: null })],
      [],
      {
        templates: [{ _id: TPL, name: 'Prudential template' }],
        sections: [{ _id: SECTION, templateId: TPL, kind: 'lead_pipeline' }],
      },
    );

    expect((await service.page(en, {})).items[0]).toMatchObject({
      actionLabel: 'Template published', targetLabel: 'Prudential template · Lead pipeline',
    });
  });

  it('P19.4-T3 AC-11 names a template, a product, a rung and a KPM request — a deleted product too', async () => {
    const { service } = make(
      [
        row({ action: 'template.renamed', targetCollection: 'templates', targetId: TPL }),
        row({ action: 'product.updated', targetCollection: 'products', targetId: PRODUCT }),
        row({ action: 'org_level.updated', targetCollection: 'companyOrgLevels', targetId: RUNG }),
        row({ action: 'kpm_request.approved', targetCollection: 'kpmRequests', targetId: REQUEST }),
      ],
      [],
      {
        templates: [{ _id: TPL, name: 'Manulife template' }],
        products: [{ _id: PRODUCT, code: 'PRUPROSPER', name: 'PRUProsper', companyId: CO, deletedAt: new Date() }],
        rungs: [{ _id: RUNG, code: 'SBP', label: 'Senior Business Partner' }],
        requests: [{ _id: REQUEST, branchName: 'Bandung Dago' }],
      },
    );

    const labels = (await service.page(id, {})).items.map((g) => [g.targetKind, g.targetLabel]);

    expect(labels).toEqual(expect.arrayContaining([
      ['Template perusahaan', 'Manulife template'],
      ['Produk', 'PRUProsper'],
      ['Peran', 'Senior Business Partner (SBP)'],
      ['Permintaan KPM', 'Bandung Dago'],
    ]));
  });

  it('P19.4-T3 AC-11 names an office’s product switch by the product of that office’s company, never another’s', async () => {
    const { service } = make(
      [row({ action: 'kpm_product.activation_set', targetCollection: 'kpmProductConfigs', targetId: 'cfg-1', kpmId: KPM,
        after: { code: 'PRUMAPAN', active: false } })],
      [],
      {
        products: [
          { _id: '66f0000000000000000000f6', code: 'PRUMAPAN', name: 'Other company’s PRUMapan', companyId: OTHER_CO },
          { _id: PRODUCT, code: 'PRUMAPAN', name: 'PRUMapan', companyId: CO },
        ],
      },
    );

    expect((await service.page(id, {})).items[0].targetLabel).toBe('PRUMapan');
  });

  it('P19.4-T3 AC-11 names an office’s own record by the member it is about, else by its KPM', async () => {
    const { service } = make(
      [
        row({ action: 'lead.updated', targetCollection: 'leads', targetId: 'l-1', kpmId: KPM, targetMembershipId: MEM }),
        row({ action: 'upload.commit', targetCollection: 'dataUploadBatches', targetId: 'b-1', kpmId: OTHER_KPM }),
      ],
      [{ _id: MEM, userId: OWNER, agentCode: 'AG-1' }],
      { offices: [{ _id: OTHER_KPM, code: '0602', branchName: 'Bandung Dago', companyId: CO }] },
    );

    const { items } = await service.page(id, {});

    expect(items.map((g) => [g.actionLabel, g.targetKind, g.targetLabel])).toEqual(expect.arrayContaining([
      ['Lead diubah', 'Prospek', 'Rangga Wibisono · AG-1'],
      ['Data bulanan diunggah', 'Data bulanan', 'KPM 0602 · Bandung Dago'],
    ]));
  });

  it('P19.4-T3 AC-11 writes a platform read’s action with the KPM it looked at (ADR-0207 §5)', async () => {
    const { service } = make([row({ action: 'platform_read.kpm_analytics', targetCollection: 'kpms', targetId: KPM })]);

    expect((await service.page(id, {})).items[0]).toMatchObject({
      actionLabel: 'Analytics KPM 0417 dilihat', targetKind: 'Kantor', targetLabel: 'KPM 0417 · Surabaya Branch',
    });
  });

  it('P19.4-T3 AC-11 reads a group of 28 autosaves as one line in words, “Draf template disimpan ×28”', async () => {
    const saves = Array.from({ length: 28 }, (_, i) => at(i * 0.3, {
      action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: SECTION,
      after: { templateId: TPL, kind: 'activity_taxonomy' },
    }));
    const { service } = make(saves, [], { templates: [{ _id: TPL, name: 'Prudential template' }] });

    const { items } = await service.page(id, {});

    expect(items.map((g) => `${g.actionLabel} ×${g.count} · ${g.targetLabel}`))
      .toEqual(['Draf template disimpan ×28 · Prudential template · Aktivitas & rasio']);
  });

  it('P19.4-T3 AC-11 offers the Tindakan chip in words, in the order of the actions', async () => {
    const { service } = make([row({ action: 'company_template.draft_saved' }), row({ action: 'company.created' })]);

    const { facets } = await service.page(en, {});

    expect(facets?.actionLabels).toEqual([
      { action: 'company.created', label: 'Company created' },
      { action: 'company_template.draft_saved', label: 'Template draft saved' },
    ]);
  });

  it('P19.4-T3 AC-11 still reads the page in a fixed number of reads, however many rows name each collection', async () => {
    const { service, audit } = make(Array.from({ length: 30 }, (_, i) => row({
      action: i % 2 ? 'product.updated' : 'template.renamed',
      targetCollection: i % 2 ? 'products' : 'templates',
      targetId: i % 2 ? PRODUCT : TPL,
      actorUserId: i % 3 ? ROOT : OWNER,
    })), [], { templates: [{ _id: TPL, name: 'T' }], products: [{ _id: PRODUCT, name: 'P', code: 'P' }] });

    const { items } = await service.page(id, {});

    expect(audit.findNewestFirst).toHaveBeenCalledTimes(1);
    expect(items.every((g) => g.targetLabel === 'T' || g.targetLabel === 'P')).toBe(true);
  });
});

describe('AuditReadService — N1 a leader note’s rows are never served to the person it is about (ADR-0073)', () => {
  const noteRow = (action: string, coachee: string, over: Record<string, unknown> = {}) => row({
    action, targetCollection: 'leaderNotes', targetId: 'n-1', targetMembershipId: null,
    after: { authorMembershipId: 'm-coach', coacheeMembershipId: coachee }, ...over,
  });
  const memberships = [
    { _id: READER_NOW, userId: READER, agentCode: 'AG-2' },
    { _id: READER_BEFORE, userId: READER, agentCode: 'AG-3' },
    { _id: SOMEBODY, userId: OWNER, agentCode: 'AG-4' },
  ];

  it('N1 drops leader_note.read and leader_note.saved about any membership of the reader’s, and serves the rest', async () => {
    const rows = [
      at(4, { action: 'leader_note.read', targetCollection: 'leaderNotes', targetId: 'n-1', after: { coacheeMembershipId: READER_NOW } }),
      at(3, { action: 'leader_note.saved', targetCollection: 'leaderNotes', targetId: 'n-2', after: { coacheeMembershipId: READER_BEFORE } }),
      at(2, { action: 'leader_note.saved', targetCollection: 'leaderNotes', targetId: 'n-3', after: { coacheeMembershipId: SOMEBODY } }),
      at(1),
    ];
    const { service, members } = make(rows, memberships);

    const { items } = await service.page({ kpmId: KPM, readerUserId: READER }, {});

    expect(items.map((r) => r._id)).toEqual([rows[3]._id, rows[2]._id]);
    // Matched by the person: the memberships the rows name are resolved to their users, once.
    expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith([SOMEBODY, READER_BEFORE, READER_NOW]);
  });

  it('N1 serves every note row to somebody they are not about', async () => {
    const rows = [noteRow('leader_note.read', READER_NOW, { targetId: 'n-a' }), noteRow('leader_note.saved', SOMEBODY, { targetId: 'n-b' })];
    const { service } = make(rows, memberships);

    expect((await service.page({ kpmId: KPM, readerUserId: OWNER }, {})).items).toHaveLength(1);
    expect((await service.page({ kpmId: KPM, readerUserId: ROOT }, {})).items).toHaveLength(2);
  });

  it('P19.2-T2 AC-6 N1 drops the reader’s rows before grouping, so the two rows around them read as one ×2', async () => {
    // A row between two identical rows breaks their group (§B.32) — unless it is a row the reader is never served,
    // which would otherwise say it was there by the break it left.
    const { service } = make([
      at(0, { action: 'member.role_changed', targetCollection: 'memberships', targetId: MEM }),
      at(1, { action: 'leader_note.read', targetCollection: 'leaderNotes', targetId: 'n-1', after: { coacheeMembershipId: READER_NOW } }),
      at(2, { action: 'member.role_changed', targetCollection: 'memberships', targetId: MEM }),
    ], memberships);

    expect(shape((await service.page({ kpmId: KPM, readerUserId: READER }, {})).items)).toEqual(['member.role_changed×2']);
    expect(shape((await service.page({ kpmId: KPM, readerUserId: ROOT }, {})).items))
      .toEqual(['member.role_changed×1', 'leader_note.read×1', 'member.role_changed×1']);
  });

  it('N1 leaves a note’s actor out of the Pelaku options', async () => {
    const { service, audit } = make([noteRow('leader_note.saved', READER_NOW)], memberships);

    await service.page({ kpmId: KPM, readerUserId: READER }, {});

    expect(audit.distinctWithin).toHaveBeenCalledWith(KPM, 'actorUserId', { action: { $not: /^leader_note\./ } });
  });
});

describe('AuditReadService — groups (P19.2-T2 AC-6; §B.32)', () => {
  it('P19.2-T2 AC-6 reads 28 autosaves of one template by one person within 10 minutes as one ×28', async () => {
    // Spread over exactly ten minutes, in whole milliseconds: the oldest is on the window's edge.
    const saves = Array.from({ length: 28 }, (_, i) => row({
      createdAt: new Date(T0 - Math.round((i * AUDIT_LOG.GROUP_WINDOW_MINUTES * MINUTE) / 27)),
      action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: CO,
    }));
    const { service } = make([...saves, at(11, { action: 'company.created', targetCollection: 'companies', targetId: CO })]);

    const { items } = await service.page(platform(), {});

    expect(shape(items)).toEqual(['company_template.draft_saved×28', 'company.created×1']);
    // The newest row stands for the group; the oldest's time comes with it.
    expect(items[0]).toMatchObject({ _id: saves[0]._id, createdAt: saves[0].createdAt, oldestAt: saves[27].createdAt });
  });

  it('P19.2-T2 AC-6 a row exactly 10 minutes older than the group’s newest joins it; one millisecond more starts another', async () => {
    const same = { action: 'product.updated', targetCollection: 'products', targetId: CO };
    const joined = make([at(0, same), at(AUDIT_LOG.GROUP_WINDOW_MINUTES, same)]);
    expect(shape((await joined.service.page(platform(), {})).items)).toEqual(['product.updated×2']);

    const past = make([at(0, same), row({ ...same, createdAt: new Date(T0 - AUDIT_LOG.GROUP_WINDOW_MINUTES * MINUTE - 1) })]);
    expect(shape((await past.service.page(platform(), {})).items)).toEqual(['product.updated×1', 'product.updated×1']);
  });

  it('P19.2-T2 AC-6 measures the window from the group’s newest row, not from the row before', async () => {
    // Rows every six minutes: each is within ten of the one above it, but the third is twelve from the first.
    const same = { action: 'product.updated', targetCollection: 'products', targetId: CO };
    const { service } = make([at(0, same), at(6, same), at(12, same)]);

    expect(shape((await service.page(platform(), {})).items)).toEqual(['product.updated×2', 'product.updated×1']);
  });

  it.each([
    ['another actor', { actorUserId: OWNER }],
    ['the same actor acting as somebody else', { effectiveUserId: OWNER }],
    ['another target', { targetId: '66f0000000000000000000a2' }],
    ['another target collection', { targetCollection: 'companies' }],
    ['another action', { action: 'kpm.reactivated' }],
  ])('P19.2-T2 AC-6 %s breaks a group', async (_label, other) => {
    const { service } = make([at(0), at(1, other), at(2)]);

    expect((await service.page(platform(), {})).items.map((g) => g.count)).toEqual([1, 1, 1]);
  });

  it('P19.2-T2 AC-6 only the next row joins: identical rows with another between them are two groups', async () => {
    const { service } = make([at(0), at(1, { action: 'kpm.reactivated' }), at(2)]);

    expect(shape((await service.page(platform(), {})).items)).toEqual(['kpm.suspended×1', 'kpm.reactivated×1', 'kpm.suspended×1']);
  });
});

describe('AuditReadService — pages (P19.2-T2 AC-6; §B.32)', () => {
  /** `n` rows a minute apart, every one its own group. */
  const distinct = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => at(from + i * 11, { targetId: (0xb0000 + i).toString(16).padStart(24, '0') }));

  it('P19.2-T2 AC-6 answers 50 groups, then the next page from the cursor, then the rest with no cursor', async () => {
    const rows = distinct(120);
    const { service } = make(rows);

    const first = await service.page(platform(), {});
    expect(first.items).toHaveLength(AUDIT_LOG.PAGE_SIZE);
    expect(first.page).toMatchObject({ cursor: null, limit: 50, hasMore: true });
    // The cursor names the last row of the page, by its time and its id.
    expect(decodeCursor(first.page.nextCursor!)).toBe(`${rows[49].createdAt.toISOString()}|${rows[49]._id}`);

    const second = await service.page(platform(), {}, first.page.nextCursor!);
    expect(second.items[0]._id).toBe(rows[50]._id);
    expect(second.page.cursor).toBe(first.page.nextCursor);

    const third = await service.page(platform(), {}, second.page.nextCursor!);
    expect(third.items.map((g) => g._id)).toEqual(rows.slice(100).map((r) => r._id));
    expect(third.page).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it('P19.2-T2 AC-6 never splits a group across two pages, however many rows it holds or batches it spans', async () => {
    // Forty-nine single rows, then the fiftieth group of 450 autosaves — more than two batches — then one more row.
    const singles = distinct(49);
    const start = 49 * 11 + 20;
    const saves = Array.from({ length: 450 }, (_, i) => row({
      createdAt: new Date(T0 - start * MINUTE - i * 1000),
      action: 'company_template.draft_saved', targetCollection: 'companyTemplates', targetId: CO,
    }));
    const after = at(start + 30, { action: 'company.created' });
    const { service, audit } = make([...singles, ...saves, after]);

    const first = await service.page(platform(), {});
    expect(first.items).toHaveLength(50);
    expect(first.items[49]).toMatchObject({ action: 'company_template.draft_saved', count: 450 });
    expect(audit.findNewestFirst.mock.calls.length).toBeGreaterThan(2);

    const second = await service.page(platform(), {}, first.page.nextCursor!);
    expect(shape(second.items)).toEqual(['company.created×1']);
  });

  it('P19.2-T2 AC-6 a log of exactly 50 groups is one page with no cursor', async () => {
    const { service } = make(distinct(50));

    expect((await service.page(platform(), {})).page).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it('P19.2-T2 AC-6 offers the chips’ options on the first page only', async () => {
    const { service } = make([at(0), at(1, { actorUserId: OWNER, action: 'company.created' })]);

    const first = await service.page(platform(), {});
    expect(first.facets).toEqual({
      actions: ['company.created', 'kpm.suspended'],
      // P19.4-T3 AC-11: each in words — a reader who has chosen nothing reads Indonesian.
      actionLabels: [
        { action: 'company.created', label: 'Perusahaan dibuat' },
        { action: 'kpm.suspended', label: 'KPM ditangguhkan' },
      ],
      actors: [{ userId: OWNER, name: 'Rangga Wibisono' }, { userId: ROOT, name: 'Root Operator' }],
    });
    expect((await service.page(platform(), {}, encodeCursor(`${new Date(T0).toISOString()}|${'f'.repeat(24)}`))).facets).toBeNull();
  });

  it.each([
    ['not base64url of a time and an id', encodeCursor('hello')],
    ['a time that is not one', encodeCursor(`yesterday|${'a'.repeat(24)}`)],
    ['an id that is not one', encodeCursor(`${new Date(T0).toISOString()}|abc`)],
    ['a third part', encodeCursor(`${new Date(T0).toISOString()}|${'a'.repeat(24)}|x`)],
  ])('P19.2-T2 AC-6 refuses a cursor that is %s, 400', async (_label, cursor) => {
    const { service } = make([at(0)]);

    const refused = await service.page(platform(), {}, cursor).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DomainException);
    expect((refused as DomainException).code).toBe('VALIDATION_FAILED');
  });

  it('P19.2-T2 AC-6 refuses a range that ends before it starts, and a day that is not one, 400', async () => {
    const { service } = make([at(0)]);

    for (const filters of [{ from: '2026-11-02', to: '2026-11-01' }, { from: '2026-02-30' }, { to: '2026-02-30' }]) {
      const refused = await service.page(platform(), filters).catch((e: unknown) => e);
      expect((refused as DomainException).code).toBe('VALIDATION_FAILED');
    }
  });
});
