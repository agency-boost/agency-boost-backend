import type { Reader } from '@/common/i18n/reader';
import { SEED_RECRUITMENT_PLAYBOOK, type RecruitmentPlaybookBody } from '@/domain/constants/recruitment';
import { SEED_RECRUITMENT_PLAYBOOK_ID } from '@/domain/constants/recruitment-words-id';

/**
 * Walks a company's playbook beside the seed and its Indonesian, path for path: a string equal to the seed's at the
 * same path becomes the Indonesian there; anything else — a field the company reworded, one the seed has no twin for —
 * is kept as typed. Lists by position, records by key.
 */
function overlay(body: unknown, seed: unknown, id: unknown): unknown {
  if (typeof body === 'string') return typeof seed === 'string' && typeof id === 'string' && body === seed ? id : body;
  if (Array.isArray(body)) {
    return body.map((item, i) => overlay(item, Array.isArray(seed) ? seed[i] : undefined, Array.isArray(id) ? id[i] : undefined));
  }
  if (typeof body === 'object' && body !== null) {
    const pick = (from: unknown, key: string) =>
      (typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined);
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, overlay(value, pick(seed, key), pick(id, key))]));
  }
  return body;
}

/**
 * **A company's playbook for its reader** (UI V1, UI-107; Phase 18.99 T13): for a reader in Indonesian, every word the
 * company still holds as the platform wrote it (`SEED_RECRUITMENT_PLAYBOOK`, byte for byte, at the same place) is served
 * in the platform's Indonesian (`SEED_RECRUITMENT_PLAYBOOK_ID`); a word the company typed is shown as typed (ADR-0179
 * §5). An English reader reads the playbook as stored. Only the plan's read uses this: the Super Admin's editor shows
 * the company's words as they are.
 */
export function playbookFor(body: RecruitmentPlaybookBody, reader: Reader): RecruitmentPlaybookBody {
  if (reader.language !== 'id') return body;
  return overlay(body, SEED_RECRUITMENT_PLAYBOOK, SEED_RECRUITMENT_PLAYBOOK_ID) as RecruitmentPlaybookBody;
}
