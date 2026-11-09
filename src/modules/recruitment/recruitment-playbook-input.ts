import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { FieldSentence } from '@/common/validation/fields';
import {
  RECRUITMENT, RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS, RECRUITMENT_MOTIVATIONS,
  type RecruitmentHesitationCode, type RecruitmentMotivationCode, type RecruitmentPlaybookBody,
  type RecruitmentProfileWords, type RecruitmentTypeCode, type RecruitmentWords,
} from '@/domain/constants';
import { RECRUITMENT_REFUSALS } from './recruitment.messages';

const SAY = RECRUITMENT_REFUSALS.VALIDATION_FAILED;

/**
 * One field a save got wrong, by its path in the request (`body.profiles.retiree.tagline`), and what is wrong with it
 * — a sentence in both languages (P18.10-T5 AC-3), written for the reader in `details.violations`.
 */
export interface PlaybookViolation {
  field: string;
  message: FieldSentence;
}

const TYPES = RECRUITMENT_CANDIDATE_TYPES.map((c) => c.code) as readonly RecruitmentTypeCode[];
const MOTIVATIONS = RECRUITMENT_MOTIVATIONS.map((c) => c.code) as readonly RecruitmentMotivationCode[];
const HESITATIONS = RECRUITMENT_HESITATIONS.map((c) => c.code) as readonly RecruitmentHesitationCode[];

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * **A whole playbook, checked whole before it is written** (P17-T8 AC-2): every profile and every
 * hesitation answered, an opening for every motivation, each text 1 to 600 characters once trimmed, a
 * profile's benefits 1 to 6, a profile's own objection only for a type and a hesitation that exist, and no
 * key the playbook does not have. **Every violation is collected before refusing**, each naming its field,
 * so a Super Admin with three empty boxes hears about three.
 *
 * Answers the playbook as it is stored: every string trimmed, every map in the vocabulary's order, a
 * profile with no objection of its own left out of `profileObjections`. Words are kept as typed — a reader
 * renders them as text (H-22), so nothing is stripped from them.
 */
export function checkPlaybookBody(raw: unknown): RecruitmentPlaybookBody {
  const violations: PlaybookViolation[] = [];
  /** Off while a missing entry is read for its shape, so it is reported once — as missing — not field by field. */
  let quiet = 0;
  const fail = (field: string, message: FieldSentence) => {
    if (quiet === 0) violations.push({ field, message });
  };

  const object = (value: unknown, field: string): Fields | null => {
    if (isFields(value)) return value;
    fail(field, SAY.notAnObject);
    return null;
  };
  const only = (fields: Fields, allowed: readonly string[], field: string) => {
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) fail(`${field}.${key}`, SAY.notPartOfPlaybook);
    }
  };
  const text = (value: unknown, field: string): string => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (typeof value !== 'string' || trimmed.length < RECRUITMENT.TEXT_MIN_LENGTH) {
      fail(field, SAY.empty);
    } else if (trimmed.length > RECRUITMENT.TEXT_MAX_LENGTH) {
      fail(field, SAY.tooLong({ max: RECRUITMENT.TEXT_MAX_LENGTH }));
    }
    return trimmed;
  };
  const words = (value: unknown, field: string): RecruitmentWords => {
    const fields = object(value, field) ?? {};
    only(fields, ['theySay', 'youSay'], field);
    return { theySay: text(fields.theySay, `${field}.theySay`), youSay: text(fields.youSay, `${field}.youSay`) };
  };
  /** A map keyed by exactly `codes`, each value read by `read`, in the codes' order. */
  const every = <K extends string, V>(value: unknown, codes: readonly K[], field: string, read: (v: unknown, f: string) => V) => {
    const fields = object(value, field) ?? {};
    only(fields, codes, field);
    return Object.fromEntries(codes.map((code) => {
      if (code in fields) return [code, read(fields[code], `${field}.${code}`)];
      fail(`${field}.${code}`, SAY.missing);
      quiet += 1;
      const shape = read(undefined, `${field}.${code}`);
      quiet -= 1;
      return [code, shape];
    })) as Record<K, V>;
  };

  const profile = (value: unknown, field: string): RecruitmentProfileWords => {
    const fields = object(value, field) ?? {};
    only(fields, ['label', 'tagline', 'goodFitFor', 'benefits', 'openings'], field);
    let benefits: string[] = [];
    if (!Array.isArray(fields.benefits)) {
      fail(`${field}.benefits`, SAY.notAList);
    } else {
      if (fields.benefits.length < RECRUITMENT.BENEFITS_MIN || fields.benefits.length > RECRUITMENT.BENEFITS_MAX) {
        fail(`${field}.benefits`, SAY.benefitsCount({ min: RECRUITMENT.BENEFITS_MIN, max: RECRUITMENT.BENEFITS_MAX }));
      }
      benefits = fields.benefits.map((b, i) => text(b, `${field}.benefits[${i}]`));
    }
    return {
      label: text(fields.label, `${field}.label`),
      tagline: text(fields.tagline, `${field}.tagline`),
      goodFitFor: text(fields.goodFitFor, `${field}.goodFitFor`),
      benefits,
      openings: every(fields.openings, MOTIVATIONS, `${field}.openings`, text),
    };
  };

  const body = object(raw, 'body') ?? {};
  only(body, ['profiles', 'objections', 'profileObjections', 'nextAction'], 'body');

  const profiles = every(body.profiles, TYPES, 'body.profiles', profile);
  const objections = every(body.objections, HESITATIONS, 'body.objections', words);

  // A profile's own objections: optional, and only for a type and a hesitation that exist.
  const own = object(body.profileObjections ?? {}, 'body.profileObjections') ?? {};
  only(own, TYPES, 'body.profileObjections');
  const profileObjections: Partial<Record<RecruitmentTypeCode, Partial<Record<RecruitmentHesitationCode, RecruitmentWords>>>> = {};
  for (const type of TYPES.filter((t) => t in own)) {
    const field = `body.profileObjections.${type}`;
    const byHesitation = object(own[type], field) ?? {};
    only(byHesitation, HESITATIONS, field);
    const read = HESITATIONS.filter((h) => h in byHesitation)
      .map((h) => [h, words(byHesitation[h], `${field}.${h}`)] as const);
    if (read.length > 0) profileObjections[type] = Object.fromEntries(read);
  }

  const nextAction = text(body.nextAction, 'body.nextAction');

  if (violations.length > 0) {
    throw new DomainException(ErrorCode.VALIDATION_FAILED, SAY.cannotPublish({ violations }), HttpStatus.BAD_REQUEST, { violations });
  }
  return { profiles, objections, profileObjections, nextAction };
}
