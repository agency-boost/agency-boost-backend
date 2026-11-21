import { BRANDING } from '@/domain/constants/branding';

/**
 * ***Nama sistem*** — a KPM's own name for the app (P19.21-T4 AC-1; ADR-0274). Pure: the check the settings page's
 * *Simpan* makes, and the replacement every email to the KPM's members takes.
 */

/** Why a name was refused. */
export type SystemNameProblem = 'systemNameBlank' | 'systemNameTooLong' | 'systemNameControl';

/** C0 and C1 control characters, line breaks and tabs included: a name is one line of plain text. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * **A name, checked**: `null` clears it (the KPM is called AgencyBoost again); a string is trimmed and must then hold
 * 1 to `SYSTEM_NAME_MAX_LENGTH` characters and no control character. Anything else is refused as blank.
 */
export function checkSystemName(input: unknown):
  | { ok: true; value: string | null }
  | { ok: false; problem: SystemNameProblem } {
  if (input === null) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, problem: 'systemNameBlank' };
  if (CONTROL.test(input)) return { ok: false, problem: 'systemNameControl' };
  const value = input.trim();
  if (value === '') return { ok: false, problem: 'systemNameBlank' };
  if ([...value].length > BRANDING.SYSTEM_NAME_MAX_LENGTH) return { ok: false, problem: 'systemNameTooLong' };
  return { ok: true, value };
}

/**
 * **The word *AgencyBoost* written as the KPM's name**: every occurrence, nothing else. `null` — or the default name
 * itself — leaves the text as it is.
 */
export function withSystemName(text: string, name: string | null | undefined): string {
  if (!name || name === BRANDING.DEFAULT_SYSTEM_NAME) return text;
  return text.split(BRANDING.DEFAULT_SYSTEM_NAME).join(name);
}
