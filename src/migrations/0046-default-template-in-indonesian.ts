import mongoose from 'mongoose';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES,
  SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238, SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238,
} from '@/domain/constants/activity-taxonomy';
import {
  SEED_ACTIVATION_ASPECTS, SEED_ACTIVATION_ITEMS, SEEDED_ACTIVATION_LABELS_BEFORE_OD_238,
} from '@/domain/constants/activation-checklist';
import {
  SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEEDED_CAPABILITY_LABELS_BEFORE_OD_238,
} from '@/domain/constants/capability';
import { SEED_EVENT_TYPES, SEEDED_EVENT_TYPE_LABELS_BEFORE_OD_238 } from '@/domain/constants/events';
import {
  SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS, SEEDED_TRAINING_WORDINGS_BEFORE_OD_238,
} from '@/domain/constants/training-taxonomy';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';

type Row = Record<string, unknown>;

/** One field of a row: the seeded English it may still hold, and the Indonesian it takes. */
interface Wording {
  before: string;
  after: string;
}

/**
 * **One list in a kind's payload**: where it is (`['aspects', 'items']` is every aspect's items), how a row in it is
 * known — by code, never by position (invariant §4) — and, per row, the fields it may rewrite.
 */
interface ListRewrite {
  path: readonly string[];
  key: (row: Row) => string;
  rows: ReadonlyMap<string, Readonly<Record<string, Wording>>>;
}

/** `[row key, field, the seeded English, the Indonesian]`. */
type Entry = readonly [key: string, field: string, before: string, after: string];

function list(path: readonly string[], entries: readonly Entry[], key = (row: Row) => String(row.code)): ListRewrite {
  const rows = new Map<string, Record<string, Wording>>();
  for (const [code, field, before, after] of entries) {
    rows.set(code, { ...rows.get(code), [field]: { before, after } });
  }
  return { path, key, rows };
}

/** A seed row by code — present, because the record of what the seed said names only codes the seed still has. */
function find<T extends { code: string }>(rows: readonly T[], code: string): T {
  const row = rows.find((r) => r.code === code);
  if (!row) throw new Error(`0046: the seed has no row ${code}, which the English it gave names.`);
  return row;
}

/**
 * **What each kind rewrites**, read from the constants: the English the seed gave before P18.98-T7 and the words it
 * gives now. Nothing is retyped here, so this cannot disagree with what a new office is given.
 */
function rewrites(): Record<string, ListRewrite[]> {
  const activity = SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238;
  const activation = SEEDED_ACTIVATION_LABELS_BEFORE_OD_238;
  const training = SEEDED_TRAINING_WORDINGS_BEFORE_OD_238;
  const capability = SEEDED_CAPABILITY_LABELS_BEFORE_OD_238;
  const items = SEED_CAPABILITY_GRIDS.flatMap((g) => g.items);

  return {
    activity_taxonomy: [
      list(['categories'], Object.entries(activity.categories).flatMap(([code, was]): Entry[] => {
        const now = find(SEED_ACTIVITY_CATEGORIES, code);
        return [
          [code, 'label', was.label, now.label],
          ...(was.summaryGroupLabel && now.summaryGroupLabel
            ? [[code, 'summaryGroupLabel', was.summaryGroupLabel, now.summaryGroupLabel] as const]
            : []),
        ];
      })),
      list(['types'], Object.entries(activity.types).map(([code, was]): Entry =>
        [code, 'label', was.label, find(SEED_ACTIVITY_TYPES, code).label])),
    ],
    lead_pipeline: [
      list(
        ['statuses'],
        Object.entries(SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238).flatMap(([pipeline, codes]) =>
          Object.entries(codes).map(([code, before]): Entry => [
            `${pipeline}:${code}`, 'label', before,
            SEED_LEAD_STATUSES.find((s) => s.pipeline === pipeline && s.code === code)!.label,
          ])),
        // A code within its pipeline: the same code in the other ladder is another status.
        (row) => `${String(row.pipeline)}:${String(row.code)}`,
      ),
    ],
    activation_checklist: [
      list(['aspects'], Object.entries(activation.aspects).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_ACTIVATION_ASPECTS, code).label])),
      list(['aspects', 'items'], Object.entries(activation.items).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_ACTIVATION_ITEMS, code).label])),
    ],
    training_taxonomy: [
      list(['categories'], Object.entries(training.categories).flatMap(([code, was]): Entry[] => {
        const now = find(SEED_TRAINING_CATEGORIES, code);
        return [
          ...(was.label ? [[code, 'label', was.label, now.label] as const] : []),
          [code, 'description', was.description, now.description as string],
        ];
      })),
      list(['skills'], Object.entries(training.skills).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_TRAINING_SKILLS, code).label])),
      list(['modules'], Object.entries(training.modules).map(([code, before]): Entry =>
        [code, 'title', before, find(SEED_TRAINING_MODULES, code).title])),
    ],
    capability_ladder: [
      list(['milestones'], Object.entries(capability.milestones).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_CAPABILITY_MILESTONES, code).label])),
      list(['grids'], Object.entries(capability.grids).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_CAPABILITY_GRIDS, code).label])),
      list(['grids', 'items'], Object.entries(capability.items).map(([code, before]): Entry =>
        [code, 'label', before, find(items, code).label])),
    ],
    event_types: [
      list(['types'], Object.entries(SEEDED_EVENT_TYPE_LABELS_BEFORE_OD_238).map(([code, before]): Entry =>
        [code, 'label', before, find(SEED_EVENT_TYPES, code).label])),
    ],
  };
}

/** Every field of `rewrite`'s list in `node` still holding its seeded English, by its dotted path from `at`. */
function seeded(node: unknown, path: readonly string[], at: string, rewrite: ListRewrite, out: Map<string, Wording>) {
  const [head, ...rest] = path;
  const rows = node && typeof node === 'object' ? (node as Row)[head] : undefined;
  if (!Array.isArray(rows)) return;
  rows.forEach((row: unknown, i) => {
    if (!row || typeof row !== 'object') return;
    const here = `${at}.${head}.${i}`;
    if (rest.length > 0) {
      seeded(row, rest, here, rewrite, out);
      return;
    }
    const fields = rewrite.rows.get(rewrite.key(row as Row)) ?? {};
    for (const [field, wording] of Object.entries(fields)) {
      if ((row as Row)[field] === wording.before) out.set(`${here}.${field}`, wording);
    }
  });
}

/**
 * **The platform's Default template in Bahasa Indonesia** (OD-238, option 1; ADR-0179 §5; P18.98-T7).
 *
 * The Template company's *Default template* (ADR-0164) is what every new office may start from, and it was mixed:
 * English activity sections, lead statuses, activation checklist, training, capability ladder and event types beside
 * Indonesian activity items. The seed is Indonesian now, so a fresh install and every reseed start in it (`0037` makes
 * the template from the seed); this is the Super Admin's retype, done for them, for an environment made before:
 *
 * - **only the Template company's Default template** (`TEMPLATE_LIBRARY`'s fixed ids), each of its six office kinds
 *   that carries words — every version, draft and published, as `0038` and `0045` rewrote a template. `ratio_set`
 *   is not touched: a ratio's name is a metric name, kept English (the approved glossary's §A.4);
 * - **only a field still holding exactly the seeded English**, found by code (a lead status by code within its
 *   pipeline): a row the Super Admin renamed keeps their words, and so does any field they edited;
 * - **never an office's own configuration, nor anything made from the template before**: an office, a snapshot, an
 *   insurer's template or a template saved from an office is a copy, never a link (ADR-0164), and keeps its words.
 *
 * **No version moves**, so no publish bar speaks and no office reads as built from another version. **Idempotent**: a
 * rewritten field no longer holds the English, and each write is guarded on the words it read. On an empty database —
 * or one `0037` made from today's seed — it finds nothing and writes nothing.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ templates: number; fields: number }> {
  const byKind = rewrites();
  const templates = db.collection('companyTemplates');
  let written = 0;
  let fields = 0;

  for (const template of await templates.find({
    companyId: TEMPLATE_LIBRARY.companyId,
    templateId: TEMPLATE_LIBRARY.defaultTemplateId,
    kind: { $in: Object.keys(byKind) },
    deletedAt: null,
  }).toArray()) {
    const found = new Map<string, Wording>();
    for (const rewrite of byKind[String(template.kind)]) seeded(template.payload, rewrite.path, 'payload', rewrite, found);
    if (found.size === 0) continue;

    const guard = Object.fromEntries([...found].map(([path, w]) => [path, w.before]));
    const set = Object.fromEntries([...found].map(([path, w]) => [path, w.after]));
    const result = await templates.updateOne({ _id: template._id, ...guard }, { $set: set });
    if (result.modifiedCount > 0) {
      written += 1;
      fields += found.size;
    }
  }

  return { templates: written, fields };
}
