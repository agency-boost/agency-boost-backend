import mongoose from 'mongoose';
import {
  SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238, SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238,
} from '@/domain/constants/activity-taxonomy';
import { SEEDED_ACTIVATION_LABELS_BEFORE_OD_238 } from '@/domain/constants/activation-checklist';
import { SEEDED_CAPABILITY_LABELS_BEFORE_OD_238 } from '@/domain/constants/capability';
import { SEEDED_EVENT_TYPE_LABELS_BEFORE_OD_238 } from '@/domain/constants/events';
import { SEEDED_TRAINING_WORDINGS_BEFORE_OD_238 } from '@/domain/constants/training-taxonomy';
import { OFFICE_TEMPLATE_KINDS, platformDefaultPayload } from '@/modules/config/template-defaults';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';
import { startMongo, stopMongo } from '../../test/mongo';
import { up as templateCompany } from './0037-template-company';
import { up } from './0046-default-template-in-indonesian';

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

const KPM_A = '66f0000000000000000000a1';
const NOW = new Date('2026-10-29T02:00:00.000Z');

/*
 * The English the seed gave before P18.98-T7, laid over today's seed — what migration 0037 wrote into the Template
 * company's Default template in every environment made before OD-238. Read from the constants, never retyped.
 */
const A = SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238;
const L = SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238;
const C = SEEDED_ACTIVATION_LABELS_BEFORE_OD_238;
const T = SEEDED_TRAINING_WORDINGS_BEFORE_OD_238;
const K = SEEDED_CAPABILITY_LABELS_BEFORE_OD_238;
const E = SEEDED_EVENT_TYPE_LABELS_BEFORE_OD_238;

const rows = (payload: Payload, key: string) => payload[key] as Row[];
const was = (map: Readonly<Record<string, string>>, row: Row, field = 'label') =>
  ({ ...row, [field]: map[String(row.code)] ?? row[field] });

function english(kind: string): Payload {
  const p = platformDefaultPayload(kind as never);
  switch (kind) {
    case 'activity_taxonomy':
      return {
        ...p,
        categories: rows(p, 'categories').map((c) => ({
          ...c,
          label: A.categories[String(c.code)]?.label ?? c.label,
          summaryGroupLabel: A.categories[String(c.code)]?.summaryGroupLabel ?? c.summaryGroupLabel,
        })),
        types: rows(p, 'types').map((t) => ({ ...t, label: A.types[String(t.code)]?.label ?? t.label })),
      };
    case 'lead_pipeline':
      return { statuses: rows(p, 'statuses').map((s) => was(L[s.pipeline as 'sales' | 'recruitment'], s)) };
    case 'activation_checklist':
      return {
        aspects: rows(p, 'aspects').map((a) => ({
          ...was(C.aspects, a), items: (a.items as Row[]).map((i) => was(C.items, i)),
        })),
      };
    case 'training_taxonomy':
      return {
        categories: rows(p, 'categories').map((c) => ({
          // *Motivation* (UI V1, P18.99-T10) was never seeded in English: it reads as the seed gives it.
          ...c,
          label: T.categories[String(c.code)]?.label ?? c.label,
          description: T.categories[String(c.code)]?.description ?? c.description,
        })),
        skills: rows(p, 'skills').map((s) => was(T.skills, s)),
        modules: rows(p, 'modules').map((m) => was(T.modules, m, 'title')),
      };
    case 'capability_ladder':
      return {
        ...p,
        milestones: rows(p, 'milestones').map((m) => was(K.milestones, m)),
        grids: rows(p, 'grids').map((g) => ({
          ...was(K.grids, g), items: (g.items as Row[]).map((i) => was(K.items, i)),
        })),
      };
    case 'event_types':
      return { types: rows(p, 'types').map((t) => was(E, t)) };
    default:
      return p;
  }
}

/** How many fields the English differs from the seed in: every one the migration is to rewrite. */
const ENGLISH_FIELDS = Object.values(A.categories).reduce((n, c) => n + 1 + (c.summaryGroupLabel ? 1 : 0), 0)
  + Object.keys(A.types).length
  + Object.values(L).reduce((n, codes) => n + Object.keys(codes).length, 0)
  + Object.keys(C.aspects).length + Object.keys(C.items).length
  + Object.values(T.categories).reduce((n, c) => n + 1 + (c.label ? 1 : 0), 0)
  + Object.keys(T.skills).length + Object.keys(T.modules).length
  + Object.keys(K.milestones).length + Object.keys(K.grids).length + Object.keys(K.items).length
  + Object.keys(E).length;

/** Every string anywhere in a value: what an "is any English left?" question reads. */
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
};
const ALL_ENGLISH = new Set([
  ...Object.values(A.categories).flatMap((c) => [c.label, c.summaryGroupLabel ?? '']).filter(Boolean),
  ...Object.values(A.types).map((t) => t.label),
  ...Object.values(L).flatMap((codes) => Object.values(codes)),
  ...Object.values(C.aspects), ...Object.values(C.items),
  ...Object.values(T.categories).flatMap((c) => [c.label ?? '', c.description]).filter(Boolean),
  ...Object.values(T.skills), ...Object.values(T.modules),
  ...Object.values(K.milestones), ...Object.values(K.grids), ...Object.values(K.items),
  ...Object.values(E),
]);

/**
 * **The platform's Default template in Bahasa Indonesia** (P18.98-T7; OD-238, option 1; ADR-0179 §5): migration 0046
 * rewrites the Template company's Default template where it still holds the seeded English — every version, by code,
 * field by field — and touches nothing else: not an office's own configuration or snapshot, not an insurer's template,
 * not a template saved from an office, not a field the Super Admin edited. Twice is once, and an empty database, or
 * one 0037 made from today's seed, is given nothing.
 */
describe('0046 — the Default template in Bahasa Indonesia (P18.98-T7, OD-238)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const templates = () => db().collection('companyTemplates');
  const defaults = { companyId: TEMPLATE_LIBRARY.companyId, templateId: TEMPLATE_LIBRARY.defaultTemplateId };
  const doc = (kind: string, payload: Payload, over: Row = {}) => ({
    ...defaults, kind, version: 1, status: 'published', payload, deletedAt: null, createdBy: null, updatedBy: null, ...over,
  });
  /** Every row of every collection, for "nothing else moved". */
  const everything = async () => {
    const out: Record<string, unknown[]> = {};
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      out[name] = await db().collection(name).find({}).sort({ _id: 1 }).toArray();
    }
    return out;
  };

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) {
      await db().collection(name).drop();
    }
  });

  it('pins the English it recognises against the seed: every row it names is the seed’s, and the words differ', () => {
    // A record naming a code the seed no longer has would rewrite nothing and say nothing; every field must change.
    expect(ENGLISH_FIELDS).toBeGreaterThan(100);
    for (const kind of OFFICE_TEMPLATE_KINDS) {
      const before = strings(english(kind));
      const after = strings(platformDefaultPayload(kind));
      expect(before).toHaveLength(after.length);
    }
    const changed = OFFICE_TEMPLATE_KINDS.reduce((n, kind) => {
      const before = strings(english(kind));
      return n + strings(platformDefaultPayload(kind)).filter((s, i) => s !== before[i]).length;
    }, 0);
    expect(changed).toBe(ENGLISH_FIELDS);
  });

  it('P18.98-T7 rewrites every kind of the Default template still holding the seeded English, versions kept', async () => {
    await templates().insertMany(OFFICE_TEMPLATE_KINDS.map((kind) => doc(kind, english(kind))));

    // Six kinds carry words; `ratio_set`'s names are metric names, kept English (§A.4), and it is not rewritten.
    expect(await up(db())).toEqual({ templates: 6, fields: ENGLISH_FIELDS });

    for (const kind of OFFICE_TEMPLATE_KINDS) {
      const row = await templates().findOne({ ...defaults, kind });
      expect({ kind, payload: row!.payload }).toEqual({ kind, payload: platformDefaultPayload(kind) });
      expect({ kind, version: row!.version, status: row!.status }).toEqual({ kind, version: 1, status: 'published' });
      expect(strings(row!.payload).filter((s) => ALL_ENGLISH.has(s))).toEqual([]);
    }
  });

  it('§C1 gives default item 10 the company in our own words, not the company’s name', async () => {
    await templates().insertOne(doc('activity_taxonomy', english('activity_taxonomy')));
    await up(db());
    const row = await templates().findOne({ ...defaults, kind: 'activity_taxonomy' });
    const ten = (row!.payload.types as Row[]).find((t) => t.code === 'DEV_TRAINING_ATTEND')!;
    expect(ten.label).toBe('Menghadiri meeting atau training dari KPM atau perusahaan');
    expect(strings(row!.payload).join(' ')).not.toContain('Prudential');
  });

  it('P18.98-T7 rewrites the drafts and later versions too, leaving every field the Super Admin edited', async () => {
    const pipeline = english('lead_pipeline');
    const edited = {
      statuses: (pipeline.statuses as Row[]).map((s) => (s.code === 'PAID_AND_ISSUED' ? { ...s, label: 'Lunas dan terbit' }
        : s.code === 'MEETING_SCHEDULED' ? { ...s, label: 'Meeting booked' } : s)),
    };
    const checklist = english('activation_checklist');
    const ownItem = {
      aspects: (checklist.aspects as Row[]).map((a) => ({
        ...a,
        label: a.code === 'INTRODUCTION' ? 'Intro' : a.label,
        items: (a.items as Row[]).map((i) => (i.code === 'INSURANCE_BASICS' ? { ...i, label: 'Learn the basics' } : i)),
      })),
    };
    await templates().insertMany([
      doc('lead_pipeline', edited, { version: 2, status: 'draft' }),
      doc('activation_checklist', ownItem, { version: 2, status: 'published' }),
    ]);

    expect(await up(db())).toEqual({
      templates: 2,
      fields: Object.keys(L.sales).length + Object.keys(L.recruitment).length - 2
        + Object.keys(C.aspects).length + Object.keys(C.items).length - 2,
    });

    const statuses = (await templates().findOne({ ...defaults, kind: 'lead_pipeline' }))!.payload.statuses as Row[];
    const seed = platformDefaultPayload('lead_pipeline').statuses as Row[];
    expect(statuses.map((s) => [s.code, s.label])).toEqual(seed.map((s) => [
      s.code, s.code === 'PAID_AND_ISSUED' ? 'Lunas dan terbit' : s.code === 'MEETING_SCHEDULED' ? 'Meeting booked' : s.label,
    ]));

    const aspects = (await templates().findOne({ ...defaults, kind: 'activation_checklist' }))!.payload.aspects as Row[];
    expect(aspects[0].label).toBe('Intro');
    expect((aspects[0].items as Row[])[0].label).toBe('Learn the basics');
    expect((aspects[0].items as Row[])[1].label).toBe('Pelajari pola pikir karier keagenan');
    expect(aspects[1].label).toBe('2. Persiapan awal');
  });

  it('P18.98-T7 finds a lead status by code within its pipeline, never the same code in the other ladder', async () => {
    await templates().insertOne(doc('lead_pipeline', {
      statuses: [
        { pipeline: 'sales', code: 'NOT_APPROACHED', label: 'Not yet approached', rank: 1 },
        { pipeline: 'recruitment', code: 'NOT_YET_APPROACHED', label: 'Not yet approached', rank: 1 },
        { pipeline: 'recruitment', code: 'NOT_APPROACHED', label: 'Not yet approached', rank: 2 },
      ],
    }));
    expect(await up(db())).toEqual({ templates: 1, fields: 1 });
    const statuses = (await templates().findOne(defaults))!.payload.statuses as Row[];
    expect(statuses.map((s) => s.label)).toEqual(['Not yet approached', 'Not yet approached', 'Belum didekati']);
  });

  it('P18.98-T7 never touches an office, its snapshots, an insurer’s template, another named template or a deleted row', async () => {
    await db().collection('leadStatuses').insertMany((english('lead_pipeline').statuses as Row[]).map((s) => ({
      kpmId: KPM_A, ...s, version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await db().collection('activityCategories').insertMany((english('activity_taxonomy').categories as Row[]).map((c) => ({
      kpmId: KPM_A, ...c, version: 1, status: 'active', archivedAt: null, deletedAt: null,
    })));
    await db().collection('configSnapshots').insertOne({
      kpmId: KPM_A, version: 1, deletedAt: null,
      payload: { leadPipelines: [{ pipeline: 'sales', statuses: english('lead_pipeline').statuses }] },
    });
    await templates().insertMany([
      // An insurer's own template, made from the defaults before OD-238.
      { ...doc('lead_pipeline', english('lead_pipeline')), companyId: '66f00000000000000000c001', templateId: 't1' },
      // A second named template in the Template company — saved from an office, or made from the defaults: a copy.
      { ...doc('event_types', english('event_types')), templateId: '66f00000000000000000d001' },
      // The campaign kinds are the company's, with no template.
      { ...doc('campaign_kinds', { kinds: [{ code: 'TRAINING', label: 'Training' }] }), templateId: null },
      // A soft-deleted row of the Default template is read by nothing.
      doc('event_types', english('event_types'), { deletedAt: NOW }),
    ]);
    const before = await everything();

    expect(await up(db())).toEqual({ templates: 0, fields: 0 });
    expect(await everything()).toEqual(before);
  });

  it('P18.98-T7 is idempotent: a second run writes nothing and changes nothing', async () => {
    await templates().insertMany(OFFICE_TEMPLATE_KINDS.map((kind) => doc(kind, english(kind))));
    await up(db());
    const after = await everything();
    expect(await up(db())).toEqual({ templates: 0, fields: 0 });
    expect(await everything()).toEqual(after);
  });

  it('P18.98-T7 reads past a payload without the lists, or with a row that is not one', async () => {
    await templates().insertMany([
      doc('activation_checklist', {}),
      doc('capability_ladder', { milestones: 'none', grids: [null, { code: 'PERSONAL_SELLING', label: 'Personal selling' }] }),
      doc('training_taxonomy', { categories: [7, { code: 'SALES' }] }),
    ]);
    expect(await up(db())).toEqual({ templates: 1, fields: 1 });
    const ladder = (await templates().findOne({ ...defaults, kind: 'capability_ladder' }))!.payload;
    expect(ladder.grids).toEqual([null, { code: 'PERSONAL_SELLING', label: 'Penjualan pribadi' }]);
  });

  it('P18.98-T7 on an empty database reads nothing and creates nothing', async () => {
    expect(await up(db())).toEqual({ templates: 0, fields: 0 });
    expect(await db().listCollections().toArray()).toEqual([]);
  });

  it('P18.98-T7 a fresh install starts Indonesian: 0037 makes the Default template from the seed, and 0046 writes none', async () => {
    await templateCompany(db(), NOW);
    const made = await everything();

    expect(await up(db())).toEqual({ templates: 0, fields: 0 });
    expect(await everything()).toEqual(made);
    for (const kind of OFFICE_TEMPLATE_KINDS) {
      const row = await templates().findOne({ ...defaults, kind });
      expect(strings(row!.payload).filter((s) => ALL_ENGLISH.has(s))).toEqual([]);
    }
  });
});
