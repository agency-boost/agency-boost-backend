import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS, RECRUITMENT_MOTIVATIONS,
  type RecruitmentHesitationCode, type RecruitmentMotivationCode, type RecruitmentPlaybookBody,
  type RecruitmentTypeCode,
} from '@/domain/constants';

/** A chip: its code, and its label verbatim (`:302-331`). */
export interface Choice {
  code: string;
  label: string;
}

/** The brief's three questions, as the chips draw them, in their order (D-vocabulary). */
export interface RecruitmentVocabulary {
  types: Choice[];
  motivations: Choice[];
  hesitations: Choice[];
}

/** A brief read from the plan's address: one type, and the motivations and hesitations in the chips' order. */
export interface RecruitmentBrief {
  type: RecruitmentTypeCode;
  motivations: RecruitmentMotivationCode[];
  hesitations: RecruitmentHesitationCode[];
}

/** A recruitment plan, as the contract shapes it (`functional/recruitment.md`, the Data contract). */
export interface RecruitmentPlan {
  brief: { type: Choice; motivations: Choice[]; hesitations: Choice[] };
  profile: { code: string; label: string; tagline: string; goodFitFor: string; benefits: string[] };
  openings: { motivation: Choice; text: string }[];
  objections: { hesitation: Choice; theySay: string; youSay: string; profileOwn: boolean }[];
  nextAction: string;
}

const choice = ({ code, label }: { code: string; label: string }): Choice => ({ code, label });

/** The chips, in order — what step 1 draws, served rather than re-declared in the browser (invariant §7). */
export function recruitmentVocabulary(): RecruitmentVocabulary {
  return {
    types: RECRUITMENT_CANDIDATE_TYPES.map(choice),
    motivations: RECRUITMENT_MOTIVATIONS.map(choice),
    hesitations: RECRUITMENT_HESITATIONS.map(choice),
  };
}

function refuse(message: string, parameters: string[]): never {
  throw new DomainException(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, { parameters });
}

/**
 * **The brief, read from `?type=&motivation=&hesitation=`** (D-plan, D-urls; T2 AC-4).
 *
 * No parameter at all is no brief: `null`, and the read answers whether there is a playbook. With a brief,
 * all three are required — one type, and `motivation` and `hesitation` each a comma-separated list of at
 * least one code — and an unknown or repeated code, an empty list or a missing parameter is refused
 * **400 `VALIDATION_FAILED`, naming the parameter in `details.parameters`**. (A parameter of any other name
 * never arrives here: the query DTO refuses it by name.) Several answers come back **in the chips' order,
 * whatever order they were sent in** (`:521`).
 */
export function readBrief(query: { type?: string; motivation?: string; hesitation?: string }): RecruitmentBrief | null {
  const given = (['type', 'motivation', 'hesitation'] as const).filter((p) => query[p] !== undefined);
  if (given.length === 0) return null;
  const missing = (['type', 'motivation', 'hesitation'] as const).filter((p) => query[p] === undefined);
  if (missing.length > 0) {
    refuse(`A brief needs a candidate type, a motivation and a hesitation; ${missing.join(' and ')} missing.`, missing);
  }

  const type = RECRUITMENT_CANDIDATE_TYPES.find((c) => c.code === query.type);
  if (!type) refuse(`"${query.type}" is not a candidate type.`, ['type']);

  const many = <C extends string>(parameter: 'motivation' | 'hesitation', vocabulary: readonly { code: C }[]): C[] => {
    const codes = String(query[parameter]).split(',');
    const known = vocabulary.map((c) => c.code) as readonly string[];
    if (codes.some((code) => !known.includes(code))) {
      refuse(`${parameter} holds a code that is not one of its answers, or none at all.`, [parameter]);
    }
    if (new Set(codes).size !== codes.length) refuse(`${parameter} names one answer twice.`, [parameter]);
    return vocabulary.map((c) => c.code).filter((code) => codes.includes(code));
  };

  return {
    type: type.code,
    motivations: many('motivation', RECRUITMENT_MOTIVATIONS),
    hesitations: many('hesitation', RECRUITMENT_HESITATIONS),
  };
}

/**
 * **The plan: one function** (D-plan; T2 AC-4, exit criterion 3) — `renderPlan` (`:565-621`) as data.
 *
 * The profile's label, tagline, *Good fit for* and benefits; **an opening per chosen motivation**, in the
 * chips' order, each with its motivation, which the screen tags only when there is more than one; **an
 * objection per chosen hesitation**, in the chips' order, **the profile's own where the playbook has one**
 * for that pair (`profileOwn`), else the base; the next action. A lookup over the company's words and
 * nothing else — no office's text, no member's data — and nothing about the brief is kept (D-store).
 */
export function recruitmentPlanFor(body: RecruitmentPlaybookBody, brief: RecruitmentBrief): RecruitmentPlan {
  const profile = body.profiles[brief.type];
  const own = body.profileObjections[brief.type] ?? {};
  const label = <C extends string>(vocabulary: readonly { code: C; label: string }[], code: C): Choice =>
    choice(vocabulary.find((c) => c.code === code)!);

  return {
    brief: {
      type: label(RECRUITMENT_CANDIDATE_TYPES, brief.type),
      motivations: brief.motivations.map((m) => label(RECRUITMENT_MOTIVATIONS, m)),
      hesitations: brief.hesitations.map((h) => label(RECRUITMENT_HESITATIONS, h)),
    },
    profile: {
      code: brief.type,
      label: profile.label,
      tagline: profile.tagline,
      goodFitFor: profile.goodFitFor,
      benefits: [...profile.benefits],
    },
    openings: brief.motivations.map((m) => ({ motivation: label(RECRUITMENT_MOTIVATIONS, m), text: profile.openings[m] })),
    objections: brief.hesitations.map((h) => {
      const theirs = own[h];
      const words = theirs ?? body.objections[h];
      return {
        hesitation: label(RECRUITMENT_HESITATIONS, h),
        theySay: words.theySay,
        youSay: words.youSay,
        profileOwn: theirs !== undefined,
      };
    }),
    nextAction: body.nextAction,
  };
}
