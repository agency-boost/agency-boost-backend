import { ulid } from 'ulid';
import { Fields, refuseWith, type FieldSentence } from '@/common/validation/fields';
import { TRAINING_REFUSALS, type ContentItem } from './training.messages';

/** What a module's content is refused with (P18.98-T5 AC-3): each sentence in both languages, its item named. */
const SAY = TRAINING_REFUSALS.VALIDATION_FAILED;

/** One uploaded file or short video, as a write sends it. */
export interface CheckedContentFile {
  id: string;
  label: string;
  storageKey: string;
  mimeType: string;
  bytes: number;
}

export interface CheckedContentLink {
  id: string;
  label: string;
  url: string;
}

export interface CheckedContent {
  files: CheckedContentFile[];
  videos: CheckedContentFile[];
  links: CheckedContentLink[];
}

export const emptyContent = (): CheckedContent => ({ files: [], videos: [], links: [] });

/** The three sections the prototype's modal names, in its order (`KPM_Owner.html:1618-1630`). */
export const CONTENT_SECTIONS = ['files', 'videos', 'links'] as const;

const LABEL = { min: 1, max: 200 } as const;
const KEY = { min: 1, max: 300 } as const;

/** How many of each a module may hold. The budget is a mid-range Android on 4G (ADR-0032). */
export const CONTENT_BOUNDS = { perSection: 20 } as const;

/**
 * A module's content, as the screen sends the whole of it (P5-T2 AC-6).
 *
 * **The whole document, not a patch.** The prototype attaches a file the moment it is chosen and
 * saves the title only on Save, so closing the modal keeps one edit and discards the other — two
 * different answers to *"did that count?"* on one screen. Here every edit is held until Save and
 * sent together, which is also what makes Cancel mean something.
 *
 * The upload is the exception it has to be: bytes go to storage when the file is chosen, because
 * they cannot be held in a form. An asset that is then never saved into a module is referenced by
 * nothing, and the orphan sweep reports it — which is what that sweep is for.
 */
export function checkTrainingContent(body: unknown): CheckedContent {
  const violations: FieldSentence[] = [];
  const source = (body ?? {}) as Record<string, unknown>;

  const outer = new Fields(source, ['files', 'videos', 'links']);
  violations.push(...outer.violations);

  const list = (key: string): unknown[] => {
    const raw = source[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      violations.push(SAY.notAList({ key }));
      return [];
    }
    if (raw.length > CONTENT_BOUNDS.perSection) {
      violations.push(SAY.sectionTooMany({ max: CONTENT_BOUNDS.perSection, key, count: raw.length }));
    }
    return raw;
  };

  const readFile = (raw: unknown, item: ContentItem): CheckedContentFile | null => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      violations.push(SAY.itemNotObject({ item }));
      return null;
    }
    const row = raw as Record<string, unknown>;
    const f = new Fields(row, ['id', 'label', 'storageKey', 'mimeType', 'bytes']);
    const label = f.text('label', LABEL, true);
    const storageKey = f.text('storageKey', KEY, true);
    const mimeType = f.text('mimeType', { min: 1, max: 200 }, true);
    violations.push(...f.violations.map((inner) => SAY.atItem({ item, inner })));
    if (label === undefined || storageKey === undefined || mimeType === undefined) return null;
    return {
      // Minted here when the screen sends a new item, so an id is never the client's to choose
      // and two offices cannot collide on one.
      id: String(row.id ?? '').trim() || ulid(),
      label,
      storageKey,
      mimeType,
      bytes: Number(row.bytes ?? 0),
    };
  };

  const readLink = (raw: unknown, item: ContentItem): CheckedContentLink | null => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      violations.push(SAY.itemNotObject({ item }));
      return null;
    }
    const row = raw as Record<string, unknown>;
    const f = new Fields(row, ['id', 'label', 'url']);
    const label = f.text('label', LABEL, true);
    violations.push(...f.violations.map((inner) => SAY.atItem({ item, inner })));

    const url = checkUrl(row.url, item, violations);
    if (label === undefined || url === null) return null;
    return { id: String(row.id ?? '').trim() || ulid(), label, url };
  };

  const content: CheckedContent = {
    files: list('files').map((r, i) => readFile(r, { kind: 'file', n: i + 1 })).filter(isPresent),
    videos: list('videos').map((r, i) => readFile(r, { kind: 'video', n: i + 1 })).filter(isPresent),
    links: list('links').map((r, i) => readLink(r, { kind: 'link', n: i + 1 })).filter(isPresent),
  };

  // An id is what an office's override names, so two items sharing one would make "remove that
  // file" ambiguous — and the ambiguity would only surface when somebody removed the wrong thing.
  const ids = [...content.files, ...content.videos, ...content.links].map((i) => i.id);
  if (new Set(ids).size !== ids.length) violations.push(SAY.sharedId);

  if (violations.length > 0) refuseWith(violations);
  return content;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * A link has to be somewhere an agent's phone will actually open.
 *
 * Plain `http` is refused as well as anything exotic: a training link is opened on a mid-range
 * Android over a mobile network, and a browser blocks or warns about an insecure page — so a link
 * that looks saved and never opens is worse than one refused while somebody can still fix it.
 */
function checkUrl(raw: unknown, item: ContentItem, violations: FieldSentence[]): string | null {
  const value = String(raw ?? '').trim();
  if (value === '') {
    violations.push(SAY.urlRequired({ item }));
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    violations.push(SAY.notAWebAddress({ item, value }));
    return null;
  }
  if (parsed.protocol !== 'https:') {
    violations.push(SAY.httpsOnly({ item, value }));
    return null;
  }
  return parsed.toString();
}

/** Every storage key a content document references. Links carry no bytes of ours. */
export const storageKeysOf = (content: CheckedContent): string[] =>
  [...content.files, ...content.videos].map((f) => f.storageKey);
