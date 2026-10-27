import { DomainException } from '@/common/errors/domain.exception';
import {
  RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS, RECRUITMENT_MOTIVATIONS, SEED_RECRUITMENT_PLAYBOOK,
  type RecruitmentPlaybookBody,
} from '@/domain/constants';
import {
  inChipOrder, nonEmptySubsets, PROTOTYPE, renderPlanPort, shippedChips, type PrototypeWords, type RenderedPlan,
} from '../../../test/recruitment-prototype';
import { readBrief, recruitmentPlanFor, recruitmentVocabulary, type RecruitmentPlan } from './recruitment-plan';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';

const TYPES = RECRUITMENT_CANDIDATE_TYPES.map((c) => c.code);
const MOTIVATIONS = RECRUITMENT_MOTIVATIONS.map((c) => c.code);
const HESITATIONS = RECRUITMENT_HESITATIONS.map((c) => c.code);

/**
 * What the screen draws from a plan (T3): the tag, the pill and *Opening line(s)* are the screen's own words
 * (`:590`, `:594`, `:602`); a motivation's tag only when there is more than one (`:567-569`).
 */
function rendered(plan: RecruitmentPlan): RenderedPlan {
  const several = plan.openings.length > 1;
  return {
    tag: 'Candidate profile',
    heading: plan.profile.label,
    tagline: plan.profile.tagline,
    pill: 'Plan ready',
    goodFitFor: plan.profile.goodFitFor,
    openingsLabel: `Opening line${several ? 's' : ''}`,
    openings: plan.openings.map((o) => ({ tag: several ? o.motivation.label : null, line: o.text })),
    benefits: plan.profile.benefits,
    objections: plan.objections.map((o) => ({ says: o.theySay, reply: o.youSay })),
    nextAction: plan.nextAction,
  };
}

/** A playbook in the prototype's own shapes, for the port to read. */
function prototypeWordsOf(body: RecruitmentPlaybookBody): PrototypeWords {
  return {
    PROFILES: Object.fromEntries(Object.entries(body.profiles).map(([code, p]) => [code, {
      label: p.label, tagline: p.tagline, bestFor: p.goodFitFor, benefits: [...p.benefits], openings: { ...p.openings },
    }])),
    OBJECTIONS: Object.fromEntries(Object.entries(body.objections).map(([h, w]) => [h, { says: w.theySay, reply: w.youSay }])),
    OBJECTION_OVERRIDES: Object.fromEntries(Object.entries(body.profileObjections).map(([t, byH]) => [
      t, Object.fromEntries(Object.entries(byH!).map(([h, w]) => [h, { says: w!.theySay, reply: w!.youSay }])),
    ])),
    CLOSING: body.nextAction,
  };
}

/**
 * **Another company's words** (exit test 3's second half): every string of the AgencyBoost words changed,
 * and the profiles' own objections moved — so a plan that read the seed constant, or the wrong company, or
 * kept the prototype's override pairs, would differ.
 */
function anotherCompanysWords(): RecruitmentPlaybookBody {
  const body = defaultPlaybookBody();
  const reword = (text: string) => `Allianz: ${text.split(' ').reverse().join(' ')}`;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return reword(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const reworded = walk(body) as RecruitmentPlaybookBody;
  return {
    ...reworded,
    profileObjections: {
      'fresh-grad': { reputation: { theySay: 'Allianz: my parents distrust insurance.', youSay: 'Allianz: show them the licence.' } },
      retiree: {
        time: reworded.profileObjections.retiree!.time!,
        'no-network': { theySay: 'Allianz: my friends have all retired.', youSay: 'Allianz: so have theirs — start there.' },
      },
    },
  };
}

describe('the recruitment plan (D-plan)', () => {
  describe('P17-T2 AC-4 — exit criterion 3: for every brief, the plan is renderPlan’s over the company’s words', () => {
    const briefs = TYPES.flatMap((type) => nonEmptySubsets(MOTIVATIONS).flatMap((motivation) =>
      nonEmptySubsets(HESITATIONS).map((hesitation) => ({ type, motivation, hesitation }))));

    it('counts 2,325 briefs: 5 types × 15 sets of motivations × 31 sets of hesitations', () => {
      expect(briefs).toHaveLength(5 * 15 * 31);
      expect(briefs).toHaveLength(2325);
    });

    it('exit test 3 equals a port of renderPlan over the prototype’s own words, for every one of the 2,325', () => {
      const differing: string[] = [];
      for (const state of briefs) {
        // Sent as the address carries them — and in reverse, which the chips’ order must undo (`:521`).
        const brief = readBrief({
          type: state.type,
          motivation: [...state.motivation].reverse().join(','),
          hesitation: [...state.hesitation].reverse().join(','),
        })!;
        const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, brief);
        const expected = renderPlanPort(PROTOTYPE, {
          type: state.type, motivation: inChipOrder('motivation', state.motivation), hesitation: inChipOrder('hesitation', state.hesitation),
        });
        if (JSON.stringify(rendered(plan)) !== JSON.stringify(expected)) differing.push(JSON.stringify(state));
      }
      expect(differing).toEqual([]);
    });

    it('exit test 3 equals the port over a second company’s different words, for every one of the 2,325', () => {
      const allianz = anotherCompanysWords();
      const words = prototypeWordsOf(allianz);
      const differing: string[] = [];
      for (const state of briefs) {
        const plan = recruitmentPlanFor(allianz, { type: state.type, motivations: state.motivation, hesitations: state.hesitation });
        const expected = renderPlanPort(words, state);
        if (JSON.stringify(rendered(plan)) !== JSON.stringify(expected)) differing.push(JSON.stringify(state));
        // And none of the AgencyBoost words leaks into another company's plan.
        expect(JSON.stringify(plan).includes(SEED_RECRUITMENT_PLAYBOOK.nextAction)).toBe(false);
      }
      expect(differing).toEqual([]);
    });

    it('marks the profile’s own objection, and only that one, for every brief', () => {
      for (const state of briefs.filter((_, i) => i % 7 === 0)) {
        const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, {
          type: state.type, motivations: state.motivation, hesitations: state.hesitation,
        });
        expect(plan.objections.map((o) => o.profileOwn))
          .toEqual(state.hesitation.map((h) => Boolean(PROTOTYPE.OBJECTION_OVERRIDES[state.type]?.[h])));
      }
    });
  });

  describe('the walk’s four briefs (Seed; the fixture header)', () => {
    it('Business owner · Side income · Already has a stable job — one opening, untagged, and the business owner’s own objection (`:497`)', () => {
      const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, readBrief({
        type: 'business-owner', motivation: 'side-income', hesitation: 'stable-job',
      })!);
      expect(plan.brief).toEqual({
        type: { code: 'business-owner', label: 'Business owner' },
        motivations: [{ code: 'side-income', label: 'Side income' }],
        hesitations: [{ code: 'stable-job', label: 'Already has a stable job' }],
      });
      expect(plan.openings).toHaveLength(1);
      expect(plan.objections).toEqual([{
        hesitation: { code: 'stable-job', label: 'Already has a stable job' },
        theySay: 'I already have my own thing running — why add this?',
        youSay: PROTOTYPE.OBJECTION_OVERRIDES['business-owner']['stable-job'].reply,
        profileOwn: true,
      }]);
    });

    it('Retiree · Flexibility and Lead a team · No network and Worried about time — two openings in the chips’ order, the base no network and the retiree’s own time (`:501`)', () => {
      const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, readBrief({
        type: 'retiree', motivation: 'leadership,flexibility', hesitation: 'time,no-network',
      })!);
      // The client's shorter words tag the openings as they label the chips (P18.95-T6 AC-2).
      expect(plan.openings.map((o) => o.motivation.label)).toEqual(['Flexibility', 'Lead a team']);
      expect(plan.objections.map((o) => [o.hesitation.code, o.profileOwn, o.theySay])).toEqual([
        ['no-network', false, 'I don\'t really have a network of people to sell to.'],
        ['time', true, 'I\'m not sure I have much time to give this right now.'],
      ]);
    });

    it('Fresh grad with every motivation and every hesitation — four openings, five objections, the profile reading Fresh graduate', () => {
      const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, readBrief({
        type: 'fresh-grad', motivation: MOTIVATIONS.join(','), hesitation: HESITATIONS.join(','),
      })!);
      expect(plan.openings).toHaveLength(4);
      expect(plan.objections).toHaveLength(5);
      expect(plan.objections.every((o) => !o.profileOwn)).toBe(true);
      expect(plan.brief.type.label).toBe('Fresh grad');
      expect(plan.profile).toMatchObject({ code: 'fresh-grad', label: 'Fresh graduate' });
      expect(plan.nextAction).toBe(PROTOTYPE.CLOSING);
    });

    it('Agent (other insurer) · Career change · Already has a stable job — the other insurer’s own reply (`:505`)', () => {
      const plan = recruitmentPlanFor(SEED_RECRUITMENT_PLAYBOOK, readBrief({
        type: 'other-insurer', motivation: 'full-career', hesitation: 'stable-job',
      })!);
      expect(plan.objections[0]).toMatchObject({
        theySay: 'I\'ve already built relationships at my current agency — why start over?', profileOwn: true,
      });
      expect(plan.profile.benefits).toEqual(PROTOTYPE.PROFILES['other-insurer'].benefits);
    });
  });

  describe('the brief, read from the address (P17-T2 AC-4)', () => {
    const refusal = (query: Record<string, string>) => {
      try {
        readBrief(query);
      } catch (err) {
        const e = err as DomainException;
        return { status: e.getStatus(), code: e.code, parameters: (e.details as { parameters: string[] }).parameters };
      }
      return null;
    };

    it('no parameter is no brief', () => {
      expect(readBrief({})).toBeNull();
    });

    it.each([
      ['no type', { motivation: 'leadership', hesitation: 'time' }, ['type']],
      ['no motivation', { type: 'retiree', hesitation: 'time' }, ['motivation']],
      ['no hesitation', { type: 'retiree', motivation: 'leadership' }, ['hesitation']],
      ['only a type', { type: 'retiree' }, ['motivation', 'hesitation']],
      ['an unknown type', { type: 'student', motivation: 'leadership', hesitation: 'time' }, ['type']],
      ['an empty motivation', { type: 'retiree', motivation: '', hesitation: 'time' }, ['motivation']],
      ['an empty hesitation', { type: 'retiree', motivation: 'leadership', hesitation: '' }, ['hesitation']],
      ['an unknown motivation', { type: 'retiree', motivation: 'leadership,fame', hesitation: 'time' }, ['motivation']],
      ['an unknown hesitation', { type: 'retiree', motivation: 'leadership', hesitation: 'time,fear' }, ['hesitation']],
      ['a motivation named twice', { type: 'retiree', motivation: 'leadership,leadership', hesitation: 'time' }, ['motivation']],
      ['a hesitation named twice', { type: 'retiree', motivation: 'leadership', hesitation: 'time,no-network,time' }, ['hesitation']],
      ['a trailing comma', { type: 'retiree', motivation: 'leadership,', hesitation: 'time' }, ['motivation']],
      ['a hesitation code given as a motivation', { type: 'retiree', motivation: 'time', hesitation: 'time' }, ['motivation']],
      ['a type given as a label', { type: 'Retiree', motivation: 'leadership', hesitation: 'time' }, ['type']],
    ])('refuses %s: 400 VALIDATION_FAILED naming the parameter', (_name, query, parameters) => {
      expect(refusal(query)).toEqual({ status: 400, code: 'VALIDATION_FAILED', parameters });
    });

    it('answers several in the chips’ order, whatever order they came in (`:521`)', () => {
      expect(readBrief({ type: 'career-switch', motivation: 'leadership,side-income,flexibility', hesitation: 'time,no-experience' }))
        .toEqual({
          type: 'career-switch',
          motivations: ['side-income', 'flexibility', 'leadership'],
          hesitations: ['no-experience', 'time'],
        });
    });
  });

  it('P18.95-T6 AC-2 serves the vocabulary as the chips draw it, in their order, in the client’s shorter words', () => {
    expect(recruitmentVocabulary()).toEqual({
      types: shippedChips('type'), motivations: shippedChips('motivation'), hesitations: shippedChips('hesitation'),
    });
  });
});
