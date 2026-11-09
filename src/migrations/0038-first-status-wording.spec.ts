import mongoose from 'mongoose';
import { SEED_LEAD_STATUSES } from '@/domain/constants';
import { SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238 } from '@/domain/constants/activity-taxonomy';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0038-first-status-wording';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_C = '66f0000000000000000000c1';
const KPM_D = '66f0000000000000000000d1';
const KPM_E = '66f0000000000000000000e1';

const OLD = 'Not approached';
const NEW = 'Not yet approached';
const OWNERS = 'Belum didekati';

/**
 * **ADR-0167 §10 for offices that already exist** (P18.7-T9 AC-6, UI-027): the recruitment pipeline's first status,
 * `NOT_APPROACHED`, says *Not yet approached* as the sales pipeline's does — in the working copy, the newest snapshot
 * agents read, and every Company template, the Template company's *Default template* among them — only where the
 * seeded *Not approached* is still there, found by code within its pipeline, no version moving, and a second run
 * doing nothing.
 */
describe('0038 — the recruitment pipeline’s first status in the sales pipeline’s words (ADR-0167 §10)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const status = (pipeline: 'sales' | 'recruitment', code: string, label: string, rank = 1, extra: object = {}) => ({
    pipeline, code, label, rank, isTerminal: false, isLateStage: false,
    version: 3, status: 'active', archivedAt: null, deletedAt: null, ...extra,
  });
  /** An office's first two of each pipeline, as the seed gave them before ADR-0167, the recruitment one as given. */
  const seeded = (first = OLD) => [
    status('sales', 'NOT_YET_APPROACHED', NEW, 1), status('sales', 'FOLLOW_UP', 'Follow-up', 2),
    status('recruitment', 'NOT_APPROACHED', first, 1), status('recruitment', 'MEETING_SCHEDULED', 'Meeting scheduled', 2),
  ];
  /** A snapshot's `leadPipelines`, as `TenantConfigService.read` renders it. */
  const pipelines = (rows: ReturnType<typeof status>[]) => (['sales', 'recruitment'] as const).map((pipeline) => ({
    pipeline,
    statuses: rows.filter((r) => r.pipeline === pipeline).map((r, i) => ({ id: `${pipeline}-${i}`, ...r })),
  }));
  const snapshot = (kpmId: string, version: number, rows: ReturnType<typeof status>[]) => ({
    kpmId, version, sourceVersion: 3, publishedAt: new Date(), publishedBy: null, deletedAt: null,
    payload: { activity: [], ratios: [], leadPipelines: pipelines(rows) },
  });
  /** The seed's statuses in the English it gave before P18.10-T7 (OD-238), which is what 0038 was written over. */
  const english = SEED_LEAD_STATUSES.map((s) => ({
    ...s, label: SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238[s.pipeline][s.code] ?? s.label,
  }));
  /** A Company template's statuses, as `platformDefaultPayload('lead_pipeline')` wrote them before ADR-0167. */
  const templateStatuses = (first = OLD) => english.map((s) => ({
    ...s, label: s.code === 'NOT_APPROACHED' ? first : s.label,
  }));

  const labelsOf = (rows: { code: string; label: string }[]) => rows.map((r) => [r.code, r.label]);
  const snapshotLabels = async (kpmId: string) =>
    (await db().collection('configSnapshots').find({ kpmId }).sort({ version: 1 }).toArray()).map((s) =>
      (s.payload.leadPipelines as { pipeline: string; statuses: { code: string; label: string }[] }[])
        .map((p) => [p.pipeline, labelsOf(p.statuses)]));

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // No model is registered for these in this file, so `clearCollections` does not reach them.
    for (const name of ['leadStatuses', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('leadStatuses').insertMany([
      // A: every word the seed's.
      ...seeded().map((s) => ({ kpmId: KPM_A, ...s })),
      // B: the same, its first recruitment status archived — a lead may still stand on it, and shows its label.
      ...seeded().map((s) => ({
        kpmId: KPM_B, ...s, ...(s.code === 'NOT_APPROACHED' ? { status: 'archived', archivedAt: new Date() } : {}),
      })),
      // C: an Owner who wrote their own, and gave the seed's old words to two statuses of their own.
      ...seeded(OWNERS).map((s) => ({ kpmId: KPM_C, ...s, ...(s.code === 'NOT_YET_APPROACHED' ? { label: OLD } : {}) })),
      { kpmId: KPM_C, ...status('recruitment', 'COLD_PROSPECT', OLD, 3) },
      // D: the code in the sales pipeline is not the recruitment pipeline's first status.
      { kpmId: KPM_D, ...status('sales', 'NOT_APPROACHED', OLD, 1) },
      // E: a soft-deleted row is read by nothing, and keeps the words it was deleted with.
      { kpmId: KPM_E, ...status('recruitment', 'NOT_APPROACHED', OLD, 1, { deletedAt: new Date() }) },
    ]);
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, seeded()), snapshot(KPM_A, 2, seeded()),
      snapshot(KPM_C, 1, [
        status('sales', 'NOT_YET_APPROACHED', OLD, 1), status('recruitment', 'NOT_APPROACHED', OWNERS, 1),
        status('recruitment', 'COLD_PROSPECT', OLD, 2),
      ]),
      snapshot(KPM_D, 1, [status('sales', 'NOT_APPROACHED', OLD, 1)]),
    ]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c1', templateId: 't1', kind: 'lead_pipeline', status: 'published', version: 2, deletedAt: null, payload: { statuses: templateStatuses() } },
      { companyId: 'c1', templateId: 't1', kind: 'lead_pipeline', status: 'draft', version: 3, deletedAt: null, payload: { statuses: templateStatuses() } },
      // Another company's template, whose Super Admin wrote their own first status.
      { companyId: 'c2', templateId: 't2', kind: 'lead_pipeline', status: 'published', version: 1, deletedAt: null, payload: { statuses: templateStatuses(OWNERS) } },
      // The Template company's Default template, as migration 0037 wrote it before ADR-0167.
      {
        companyId: TEMPLATE_LIBRARY.companyId, templateId: TEMPLATE_LIBRARY.defaultTemplateId, kind: 'lead_pipeline',
        status: 'published', version: 1, deletedAt: null, payload: { statuses: templateStatuses() },
      },
      // Another kind holding the same words is not a lead pipeline.
      { companyId: 'c1', templateId: 't1', kind: 'activity_taxonomy', status: 'published', version: 1, deletedAt: null, payload: { statuses: templateStatuses() } },
    ]);
  });

  it('P18.7-T9 AC-6 rewrites the seeded words in the working copy, archived rows included, versions kept', async () => {
    // A's and B's first recruitment status.
    expect(await up(db())).toEqual({ statuses: 2, snapshots: 1, templates: 3 });

    for (const kpmId of [KPM_A, KPM_B]) {
      const rows = await db().collection('leadStatuses').find({ kpmId }).sort({ pipeline: -1, rank: 1 }).toArray();
      expect(rows.map((r) => [r.pipeline, r.code, r.label, r.version])).toEqual([
        ['sales', 'NOT_YET_APPROACHED', NEW, 3],
        ['sales', 'FOLLOW_UP', 'Follow-up', 3],
        ['recruitment', 'NOT_APPROACHED', NEW, 3],
        ['recruitment', 'MEETING_SCHEDULED', 'Meeting scheduled', 3],
      ]);
    }
    expect((await db().collection('leadStatuses').findOne({ kpmId: KPM_B, code: 'NOT_APPROACHED' }))!.status).toBe('archived');
  });

  it('P18.7-T9 AC-6 rewrites the newest snapshot agents read, and leaves the older one as history', async () => {
    await up(db());
    const before = [['sales', [['NOT_YET_APPROACHED', NEW], ['FOLLOW_UP', 'Follow-up']]],
      ['recruitment', [['NOT_APPROACHED', OLD], ['MEETING_SCHEDULED', 'Meeting scheduled']]]];
    const after = [['sales', [['NOT_YET_APPROACHED', NEW], ['FOLLOW_UP', 'Follow-up']]],
      ['recruitment', [['NOT_APPROACHED', NEW], ['MEETING_SCHEDULED', 'Meeting scheduled']]]];
    expect(await snapshotLabels(KPM_A)).toEqual([before, after]);
    // No version moves in a snapshot either: the publish bar reads `(id, version)`, and both are what they were.
    const newest = await db().collection('configSnapshots').findOne({ kpmId: KPM_A, version: 2 });
    expect(newest!.payload.leadPipelines[1].statuses[0]).toMatchObject({ id: 'recruitment-0', version: 3, label: NEW });
  });

  it('P18.7-T9 AC-6 rewrites the Company templates, published and draft, and the Template company’s Default template', async () => {
    await up(db());
    const templates = await db().collection('companyTemplates').find({ kind: 'lead_pipeline' }).toArray();
    const firstOf = (t: (typeof templates)[number]) =>
      (t.payload.statuses as { pipeline: string; code: string; label: string }[])
        .filter((s) => s.pipeline === 'recruitment' && s.code === 'NOT_APPROACHED').map((s) => s.label);
    expect(templates.map((t) => [t.companyId, t.status, t.version, firstOf(t)])).toEqual([
      ['c1', 'published', 2, [NEW]],
      ['c1', 'draft', 3, [NEW]],
      ['c2', 'published', 1, [OWNERS]],
      [TEMPLATE_LIBRARY.companyId, 'published', 1, [NEW]],
    ]);
    // Every other status of a rewritten template is the seed's English, as it was: 0038 writes the words it was
    // written for, and the Indonesian since P18.10-T7 is 0046's to give (OD-238).
    const defaults = templates.find((t) => t.templateId === TEMPLATE_LIBRARY.defaultTemplateId)!;
    expect(defaults.payload.statuses).toEqual(english);

    const other = await db().collection('companyTemplates').findOne({ kind: 'activity_taxonomy' });
    expect(other!.payload.statuses).toEqual(templateStatuses());
  });

  it('P18.7-T9 AC-6 leaves an Owner’s own label, the sales pipeline’s first status and another code holding the old words alone', async () => {
    await up(db());
    const c = await db().collection('leadStatuses').find({ kpmId: KPM_C }).sort({ pipeline: -1, rank: 1 }).toArray();
    expect(c.map((r) => [r.pipeline, r.code, r.label])).toEqual([
      // The Owner gave the sales pipeline's first status the old words: it is not the recruitment pipeline's.
      ['sales', 'NOT_YET_APPROACHED', OLD],
      ['sales', 'FOLLOW_UP', 'Follow-up'],
      ['recruitment', 'NOT_APPROACHED', OWNERS],
      ['recruitment', 'MEETING_SCHEDULED', 'Meeting scheduled'],
      ['recruitment', 'COLD_PROSPECT', OLD],
    ]);
    expect(await snapshotLabels(KPM_C)).toEqual([[
      ['sales', [['NOT_YET_APPROACHED', OLD]]],
      ['recruitment', [['NOT_APPROACHED', OWNERS], ['COLD_PROSPECT', OLD]]],
    ]]);

    // The code in the other pipeline, and a soft-deleted row.
    expect((await db().collection('leadStatuses').findOne({ kpmId: KPM_D }))!.label).toBe(OLD);
    expect(await snapshotLabels(KPM_D)).toEqual([[['sales', [['NOT_APPROACHED', OLD]]], ['recruitment', []]]]);
    expect((await db().collection('leadStatuses').findOne({ kpmId: KPM_E }))!.label).toBe(OLD);
  });

  it('P18.7-T9 AC-6 is idempotent: a second run writes nothing', async () => {
    await up(db());
    expect(await up(db())).toEqual({ statuses: 0, snapshots: 0, templates: 0 });
  });

  it('P18.7-T9 AC-6 passes over a snapshot published without lead pipelines', async () => {
    await db().collection('configSnapshots').insertOne({
      kpmId: KPM_B, version: 1, sourceVersion: 1, publishedAt: new Date(), publishedBy: null, deletedAt: null, payload: { ratios: [] },
    });
    await expect(up(db())).resolves.toMatchObject({ snapshots: 1 });
    expect((await db().collection('configSnapshots').findOne({ kpmId: KPM_B }))!.payload).toEqual({ ratios: [] });
  });

  it('P18.7-T9 AC-6 on an empty database reads nothing and creates nothing', async () => {
    for (const name of ['leadStatuses', 'configSnapshots', 'companyTemplates']) await db().collection(name).drop();
    expect(await up(db())).toEqual({ statuses: 0, snapshots: 0, templates: 0 });
    const names = (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names).not.toEqual(expect.arrayContaining(['leadStatuses']));
    expect(names).not.toEqual(expect.arrayContaining(['configSnapshots']));
    expect(names).not.toEqual(expect.arrayContaining(['companyTemplates']));
  });
});
