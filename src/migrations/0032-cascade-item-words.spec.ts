import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0032-cascade-item-words';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_C = '66f0000000000000000000c1';

const OLD_3 = 'Menghubungi prospek yang sudah ada';
const NEW_3 = 'Set Appointment';
const NOTE_3 = 'telepon, WhatsApp, tatap muka, dll';
const PROTOTYPE_7 = 'Presentasi NBO ke calon agen';
const P13_7 = 'Proses pendaftaran kode agen';
const NEW_7 = 'Melakukan presentasi recruitment';
const NOTE_7 = 'secara mandiri atau melalui BOP';
const OLD_8 = 'Melakukan diskusi follow up dari presentasi NBO sebelumnya';
const NEW_8 = 'Melakukan diskusi follow up dari presentasi recruitment sebelumnya';

/**
 * **ADR-0160 §1 for offices that already exist** (P18.8-T8 AC-3): items 3, 7 and 8 take the client's words in the
 * working copy, the newest snapshot agents read, and every Company template — only where a seeded wording is still
 * there (both of item 7's), item 7's note going with its seeded label, no version moving, and a second run doing
 * nothing.
 */
describe('0032 — items 3, 7 and 8 in the client’s words (ADR-0160 §1)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const type = (code: string, label: string, description: string | null = null, displayOrder = 1) => ({
    code, label, description, displayOrder, version: 4, status: 'active', archivedAt: null, deletedAt: null,
  });
  /** An office's seeded three: item 7 in the wording given, with its note. */
  const seeded = (seven: string) => [
    type('LEADS_CONTACTED', OLD_3, NOTE_3, 3), type('RECRUIT_PRESENTATION', seven, NOTE_7, 7),
    type('RECRUIT_FOLLOWUP', OLD_8, null, 8),
  ];
  const snapshot = (kpmId: string, version: number, types: ReturnType<typeof type>[]) => ({
    kpmId, version, sourceVersion: 4, publishedAt: new Date(), publishedBy: null, deletedAt: null,
    payload: {
      activity: [
        { code: 'LEADS_GENERATION', label: 'Leads Generation', types: types.filter((t) => t.code.startsWith('LEADS')) },
        { code: 'RECRUITMENT', label: 'Recruitment', types: types.filter((t) => t.code.startsWith('RECRUIT')) },
      ],
      ratios: [],
    },
  });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // No model is registered for these in this file, so `clearCollections` does not reach them.
    for (const name of ['activityTypes', 'configSnapshots', 'companyTemplates']) await db().collection(name).deleteMany({});
    await db().collection('activityTypes').insertMany([
      // A: provisioned before P13.1-T3, every word the seed's.
      ...seeded(PROTOTYPE_7).map((t) => ({ kpmId: KPM_A, ...t })),
      // B: provisioned after it.
      ...seeded(P13_7).map((t) => ({ kpmId: KPM_B, ...t })),
      // C: an Owner who wrote their own item 3 and item 7, kept the seeded note on 7, and wrote one on item 8.
      { kpmId: KPM_C, ...type('LEADS_CONTACTED', 'Telepon prospek', NOTE_3, 3) },
      { kpmId: KPM_C, ...type('RECRUIT_PRESENTATION', 'Presentasi BOP', NOTE_7, 7) },
      { kpmId: KPM_C, ...type('RECRUIT_FOLLOWUP', OLD_8, 'Catatan kami', 8) },
      // Another code holding the same words is not item 3.
      { kpmId: KPM_C, ...type('OFFICE_CALLS', OLD_3, null, 13) },
    ]);
    await db().collection('configSnapshots').insertMany([
      snapshot(KPM_A, 1, seeded(PROTOTYPE_7)), snapshot(KPM_A, 2, seeded(PROTOTYPE_7)),
      snapshot(KPM_C, 1, [type('LEADS_CONTACTED', 'Telepon prospek', NOTE_3, 3), type('RECRUIT_PRESENTATION', 'Presentasi BOP', NOTE_7, 7)]),
    ]);
    await db().collection('companyTemplates').insertMany([
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'published', version: 2, payload: { categories: [], types: seeded(P13_7) } },
      { companyId: 'c1', kind: 'activity_taxonomy', status: 'draft', version: 3, payload: { categories: [], types: [type('LEADS_CONTACTED', 'Edited.')] } },
      { companyId: 'c1', kind: 'ratio_set', status: 'published', version: 1, payload: { types: seeded(P13_7) } },
    ]);
  });

  it('P18.8-T8 AC-3 rewrites the seeded words in the working copy, the newest snapshot and the templates, versions kept', async () => {
    // A's three and B's three; C's item 8, whose label is the seed's though its note is an Owner's.
    expect(await up(db())).toEqual({ types: 7, snapshots: 1, templates: 1 });

    for (const kpmId of [KPM_A, KPM_B]) {
      const rows = await db().collection('activityTypes').find({ kpmId }).sort({ displayOrder: 1 }).toArray();
      expect(rows.map((r) => [r.code, r.label, r.description, r.version])).toEqual([
        ['LEADS_CONTACTED', NEW_3, NOTE_3, 4],
        // Both of item 7's seeded wordings, and its note with them.
        ['RECRUIT_PRESENTATION', NEW_7, null, 4],
        ['RECRUIT_FOLLOWUP', NEW_8, null, 4],
      ]);
    }

    const snaps = await db().collection('configSnapshots').find({ kpmId: KPM_A }).sort({ version: 1 }).toArray();
    const labels = (s: (typeof snaps)[number]) =>
      (s.payload.activity as { types: { label: string; description: string | null }[] }[])
        .flatMap((c) => c.types.map((t) => [t.label, t.description]));
    // The newest, which agents read; the older one is history.
    expect(labels(snaps[0])).toEqual([[OLD_3, NOTE_3], [PROTOTYPE_7, NOTE_7], [OLD_8, null]]);
    expect(labels(snaps[1])).toEqual([[NEW_3, NOTE_3], [NEW_7, null], [NEW_8, null]]);

    const templates = await db().collection('companyTemplates').find({}).sort({ version: 1 }).toArray();
    expect(templates.map((t) => [t.kind, t.version, (t.payload.types as { label: string }[]).map((x) => x.label)])).toEqual([
      // Another kind holding the same words is not an activity taxonomy.
      ['ratio_set', 1, [OLD_3, P13_7, OLD_8]],
      ['activity_taxonomy', 2, [NEW_3, NEW_7, NEW_8]],
      ['activity_taxonomy', 3, ['Edited.']],
    ]);
    expect(templates[1].payload.types[1].description).toBeNull();
  });

  it('P18.8-T8 AC-3 leaves an Owner’s own words alone, and the note beside a label they wrote', async () => {
    await up(db());
    const rows = await db().collection('activityTypes').find({ kpmId: KPM_C }).sort({ displayOrder: 1 }).toArray();
    expect(rows.map((r) => [r.code, r.label, r.description])).toEqual([
      ['LEADS_CONTACTED', 'Telepon prospek', NOTE_3],
      ['RECRUIT_PRESENTATION', 'Presentasi BOP', NOTE_7],
      // The seed's label takes the new words; the Owner's note stays.
      ['RECRUIT_FOLLOWUP', NEW_8, 'Catatan kami'],
      ['OFFICE_CALLS', OLD_3, null],
    ]);
    const snap = await db().collection('configSnapshots').findOne({ kpmId: KPM_C });
    expect(snap!.payload.activity.flatMap((c: { types: { label: string }[] }) => c.types.map((t) => t.label)))
      .toEqual(['Telepon prospek', 'Presentasi BOP']);
  });

  it('P18.8-T8 AC-3 is idempotent: a second run writes nothing', async () => {
    await up(db());
    expect(await up(db())).toEqual({ types: 0, snapshots: 0, templates: 0 });
  });

  it('P18.8-T8 AC-3 passes over a snapshot published without an activity taxonomy', async () => {
    await db().collection('configSnapshots').insertOne({
      kpmId: KPM_B, version: 1, sourceVersion: 1, publishedAt: new Date(), publishedBy: null, deletedAt: null, payload: { ratios: [] },
    });
    await expect(up(db())).resolves.toMatchObject({ snapshots: 1 });
    expect((await db().collection('configSnapshots').findOne({ kpmId: KPM_B }))!.payload).toEqual({ ratios: [] });
  });
});
