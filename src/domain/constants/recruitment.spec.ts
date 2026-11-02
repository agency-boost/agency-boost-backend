import {
  ASSET_LIMITS, DOCUMENT_MIME_TYPES, RECRUITMENT, RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS,
  RECRUITMENT_MOTIVATIONS, RECRUITMENT_PITCH_SLOTS, RECRUITMENT_PITCH_STATES, SEED_RECRUITMENT_PLAYBOOK,
  recruitmentPitchDone, recruitmentPitchState, recruitmentPitchSummary, type RecruitmentPitchState,
} from '@/domain/constants';
import { CLIENT_CHIP_WORDS, PROTOTYPE, prototypeChips, shippedChips } from '../../../test/recruitment-prototype';

/**
 * **Phase 17's constants, pinned against the prototype** (D-vocabulary, D-slots; P17-T2 AC-2, P17-T4 AC-1).
 *
 * Read out of `AgencyBoost_Recruitment_Section.html` rather than retyped (`test/recruitment-prototype.ts`):
 * the chips from its markup, the playbook and the slots from its script. A word changed here, or there,
 * fails here first.
 */
describe('the recruitment constants (Phase 17)', () => {
  describe('the candidate brief’s vocabulary (D-vocabulary, `:302-331`)', () => {
    it('P17-T2 AC-2 the five candidate types are the chips’, codes and labels, in the chips’ order', () => {
      expect(RECRUITMENT_CANDIDATE_TYPES.map((c) => ({ ...c }))).toEqual(prototypeChips('type'));
      expect(RECRUITMENT_CANDIDATE_TYPES.map((c) => c.code))
        .toEqual(['fresh-grad', 'career-switch', 'business-owner', 'retiree', 'other-insurer']);
    });

    it('P17-T2 AC-2, P18.95-T6 AC-2 the four motivations are the chips’, in their order, in the client’s shorter words', () => {
      expect(RECRUITMENT_MOTIVATIONS.map((c) => ({ ...c }))).toEqual(shippedChips('motivation'));
      expect(RECRUITMENT_MOTIVATIONS.map((c) => c.code)).toEqual(['side-income', 'full-career', 'flexibility', 'leadership']);
    });

    it('P17-T2 AC-2, P18.95-T6 AC-2 the five hesitations are the chips’, in their order, three in the client’s words', () => {
      expect(RECRUITMENT_HESITATIONS.map((c) => ({ ...c }))).toEqual(shippedChips('hesitation'));
      expect(RECRUITMENT_HESITATIONS.map((c) => c.code))
        .toEqual(['no-experience', 'stable-job', 'reputation', 'no-network', 'time']);
    });
  });

  describe('P18.95-T6 AC-2 — the client’s shorter labels (UI-015, ADR-0167; parity I-421)', () => {
    it('P18.95-T6 AC-2 labels: the seven chips read the client’s words, at every size', () => {
      expect(RECRUITMENT_MOTIVATIONS.map((c) => c.label)).toEqual(['Side income', 'Career change', 'Flexibility', 'Lead a team']);
      expect(RECRUITMENT_HESITATIONS.map((c) => c.label))
        .toEqual(['No sales exp.', 'Already has a stable job', 'Bad reputation', 'No network', 'Worried about time commitment']);
    });

    it('P18.95-T6 AC-2 codes unchanged: every chip keeps the prototype’s data-val, in its order', () => {
      for (const [question, shipped] of [['motivation', RECRUITMENT_MOTIVATIONS], ['hesitation', RECRUITMENT_HESITATIONS]] as const) {
        expect(shipped.map((c) => c.code)).toEqual(prototypeChips(question).map((c) => c.code));
      }
      // Each of the client's words replaces a chip that exists, and nothing else departs from the file.
      const departing = [...RECRUITMENT_MOTIVATIONS, ...RECRUITMENT_HESITATIONS, ...RECRUITMENT_CANDIDATE_TYPES]
        .filter((c) => ![...prototypeChips('motivation'), ...prototypeChips('hesitation'), ...prototypeChips('type')]
          .some((p) => p.code === c.code && p.label === c.label))
        .map((c) => [c.code, c.label]);
      expect(departing).toEqual(Object.entries(CLIENT_CHIP_WORDS));
    });

    it('P18.95-T6 AC-2 the two hesitations the client gave no words for keep the prototype’s', () => {
      const prototype = Object.fromEntries(prototypeChips('hesitation').map((c) => [c.code, c.label]));
      expect(RECRUITMENT_HESITATIONS.filter((c) => c.code === 'stable-job' || c.code === 'time').map((c) => c.label))
        .toEqual([prototype['stable-job'], prototype.time]);
    });
  });

  describe('the seed playbook — the prototype’s words verbatim (P17-T2 AC-2, `:394-510`)', () => {
    const body = SEED_RECRUITMENT_PLAYBOOK;

    it('P17-T2 AC-2 has a profile for every candidate type, and an opening for every motivation in each', () => {
      expect(Object.keys(body.profiles)).toEqual(RECRUITMENT_CANDIDATE_TYPES.map((c) => c.code));
      expect(Object.keys(body.profiles)).toEqual(Object.keys(PROTOTYPE.PROFILES));
      for (const profile of Object.values(body.profiles)) {
        expect(Object.keys(profile.openings)).toEqual(RECRUITMENT_MOTIVATIONS.map((c) => c.code));
        expect(profile.benefits).toHaveLength(4);
      }
    });

    it('P17-T2 AC-2 each profile’s label, tagline, Good fit for, benefits and openings are the prototype’s', () => {
      for (const [code, profile] of Object.entries(body.profiles)) {
        const theirs = PROTOTYPE.PROFILES[code];
        expect({ code, ...profile, benefits: [...profile.benefits], openings: { ...profile.openings } }).toEqual({
          code,
          label: theirs.label,
          tagline: theirs.tagline,
          goodFitFor: theirs.bestFor,
          benefits: theirs.benefits,
          openings: theirs.openings,
        });
      }
    });

    it('P17-T2 AC-2 a base objection for every hesitation, the prototype’s', () => {
      expect(Object.keys(body.objections)).toEqual(RECRUITMENT_HESITATIONS.map((c) => c.code));
      for (const [code, words] of Object.entries(body.objections)) {
        expect({ code, ...words }).toEqual({
          code, theySay: PROTOTYPE.OBJECTIONS[code].says, youSay: PROTOTYPE.OBJECTIONS[code].reply,
        });
      }
    });

    it('P17-T2 AC-2 the three profiles’ own objections (`OBJECTION_OVERRIDES`, `:495`) and the next action (`:510`)', () => {
      const own = Object.fromEntries(Object.entries(body.profileObjections).map(([type, byHesitation]) => [
        type,
        Object.fromEntries(Object.entries(byHesitation!).map(([h, w]) => [h, { says: w!.theySay, reply: w!.youSay }])),
      ]));
      expect(own).toEqual(PROTOTYPE.OBJECTION_OVERRIDES);
      expect(Object.keys(own)).toEqual(['business-owner', 'retiree', 'other-insurer']);
      expect(body.nextAction).toBe(PROTOTYPE.CLOSING);
    });

    it('P17-T2 AC-2 is 72 strings, every one of them the prototype’s', () => {
      const ours = [
        ...Object.values(body.profiles).flatMap((p) => [
          p.label, p.tagline, p.goodFitFor, ...p.benefits, ...Object.values(p.openings),
        ]),
        ...Object.values(body.objections).flatMap((w) => [w.theySay, w.youSay]),
        ...Object.values(body.profileObjections).flatMap((byH) => Object.values(byH!).flatMap((w) => [w!.theySay, w!.youSay])),
        body.nextAction,
      ];
      const theirs = [
        ...Object.values(PROTOTYPE.PROFILES).flatMap((p) => [
          p.label, p.tagline, p.bestFor, ...p.benefits, ...Object.values(p.openings),
        ]),
        ...Object.values(PROTOTYPE.OBJECTIONS).flatMap((w) => [w.says, w.reply]),
        ...Object.values(PROTOTYPE.OBJECTION_OVERRIDES).flatMap((byH) => Object.values(byH).flatMap((w) => [w.says, w.reply])),
        PROTOTYPE.CLOSING,
      ];
      expect(ours).toHaveLength(72);
      expect(ours).toEqual(theirs);
    });

    it('P17-T2 AC-2 sits within the bounds a Super Admin’s save is held to, so the defaults always save', () => {
      const strings = JSON.stringify(body).match(/"(?:[^"\\]|\\.)*"/g)!.map((s) => JSON.parse(s) as string);
      for (const text of strings) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThanOrEqual(RECRUITMENT.TEXT_MIN_LENGTH);
        expect(text.length).toBeLessThanOrEqual(RECRUITMENT.TEXT_MAX_LENGTH);
      }
    });
  });

  describe('the office’s pitch slots (D-slots, `:626-661`; ADR-0177)', () => {
    /** The four the prototype draws: required, and first. */
    const FOUR = RECRUITMENT_PITCH_SLOTS.slice(0, 4);

    it('P17-T4 AC-1 the four slots, their titles and lines, in the order drawn — the prototype’s, each required', () => {
      expect(FOUR.map(({ code, title, line }) => ({ code, title, line })))
        .toEqual(PROTOTYPE.SLOTS.map((s) => ({ code: s.id, title: s.title, line: s.desc })));
      expect(FOUR.map((s) => s.code)).toEqual(['opportunity', 'proof', 'faq', 'howtojoin']);
      expect(FOUR.map((s) => s.required)).toEqual([true, true, true, true]);
      // The prototype draws four and no more: every slot after them is ours, and optional.
      expect(PROTOTYPE.SLOTS).toHaveLength(4);
    });

    it('P17-T4 AC-1 the checklist is Opportunity Overview’s alone: its four items by the prototype’s ids and labels', () => {
      for (const slot of FOUR) {
        const theirs = PROTOTYPE.SLOTS.find((s) => s.id === slot.code)!.checklist ?? [];
        expect([slot.code, slot.checklist.map((i) => ({ ...i }))])
          .toEqual([slot.code, theirs.map((i) => ({ code: i.id, label: i.label }))]);
      }
      expect(RECRUITMENT_PITCH_SLOTS[0].checklist.map((i) => i.code)).toEqual(['career-path', 'income', 'support', 'commitment']);
      expect(RECRUITMENT_PITCH_SLOTS.filter((s) => s.checklist.length > 0).map((s) => s.code)).toEqual(['opportunity']);
    });

    it('P18.97-T5 AC-2 six slots: after the four, Company Profile and Agency Profile — optional, with no checklist (UI-042)', () => {
      expect(RECRUITMENT_PITCH_SLOTS.map((s) => s.code)).toEqual(['opportunity', 'proof', 'faq', 'howtojoin', 'company', 'agency']);
      expect(RECRUITMENT_PITCH_SLOTS.slice(4).map(({ code, title, required, checklist }) => ({ code, title, required, checklist: [...checklist] })))
        .toEqual([
          { code: 'company', title: 'Company Profile', required: false, checklist: [] },
          { code: 'agency', title: 'Agency Profile', required: false, checklist: [] },
        ]);
      // Each carries a line, served as the four's are and drawn on no card; none names one of OD-39's six words.
      for (const slot of RECRUITMENT_PITCH_SLOTS.slice(4)) {
        expect(slot.line.length).toBeGreaterThan(0);
        expect(slot.line).not.toMatch(/\boffice\b|\bKPM\b|reports to|tagged to|untagged|unassigned/i);
      }
      // Four required, so the ring reads x/4.
      expect(RECRUITMENT_PITCH_SLOTS.filter((s) => s.required)).toHaveLength(4);
    });

    it('P17-T4 AC-1 the states, and the completion rule stated once (`slotStatus`, `:681-691`)', () => {
      expect(RECRUITMENT_PITCH_STATES).toEqual(['missing', 'complete', 'partial', 'uploaded']);
      const items = (...ticks: boolean[]) => ticks.map((ticked) => ({ ticked }));
      // No file: missing, whatever the ticks say.
      expect(recruitmentPitchState(false, [])).toBe('missing');
      expect(recruitmentPitchState(false, items(true, true, true, true))).toBe('missing');
      // A file on a slot with no checklist: uploaded.
      expect(recruitmentPitchState(true, [])).toBe('uploaded');
      // A file and its checklist: complete only with every item ticked.
      expect(recruitmentPitchState(true, items(true, true, true, true))).toBe('complete');
      expect(recruitmentPitchState(true, items(true, false, true, false))).toBe('partial');
      expect(recruitmentPitchState(true, items(false, false, false, false))).toBe('partial');
    });

    it('P17-T4 AC-1 a slot is done for the banner when complete or uploaded (`:797-799`)', () => {
      expect(RECRUITMENT_PITCH_STATES.filter(recruitmentPitchDone)).toEqual(['complete', 'uploaded']);
    });

    describe('P18.97-T5 AC-3 — the banner counts the four required alone (ADR-0177 §3)', () => {
      /** The six slots in a state each, by code. */
      const six = (states: Partial<Record<string, RecruitmentPitchState>>) =>
        RECRUITMENT_PITCH_SLOTS.map((s) => ({ required: s.required, state: states[s.code] ?? 'missing' }));

      it('P18.97-T5 AC-3 nothing uploaded: 0 of 4, four missing — the two optional ones are not counted missing', () => {
        expect(recruitmentPitchSummary(six({}))).toEqual({ done: 0, total: 4, missing: 4, unconfirmed: 0 });
      });

      it('P18.97-T5 AC-3 0417’s pitch: 1 of 4, two missing, one needs checking — whatever the optional ones hold', () => {
        const required = { opportunity: 'partial', proof: 'uploaded' } as const;
        const expected = { done: 1, total: 4, missing: 2, unconfirmed: 1 };
        for (const optional of [{}, { company: 'uploaded' }, { agency: 'uploaded' }, { company: 'uploaded', agency: 'uploaded' }] as const) {
          expect([optional, recruitmentPitchSummary(six({ ...required, ...optional }))]).toEqual([optional, expected]);
        }
      });

      it('P18.97-T5 AC-3 the four done reads complete, with neither optional document or with both', () => {
        const four = { opportunity: 'complete', proof: 'uploaded', faq: 'uploaded', howtojoin: 'uploaded' } as const;
        expect(recruitmentPitchSummary(six(four))).toEqual({ done: 4, total: 4, missing: 0, unconfirmed: 0 });
        expect(recruitmentPitchSummary(six({ ...four, company: 'uploaded', agency: 'uploaded' })))
          .toEqual({ done: 4, total: 4, missing: 0, unconfirmed: 0 });
      });

      it('P18.97-T5 AC-3 an optional slot counts in no figure, in any state the rule could give it', () => {
        for (const state of RECRUITMENT_PITCH_STATES) {
          expect([state, recruitmentPitchSummary([{ required: false, state }])])
            .toEqual([state, { done: 0, total: 0, missing: 0, unconfirmed: 0 }]);
        }
      });
    });
  });

  describe('the bounds (D-slots, OD-88)', () => {
    it('P17-T4 AC-6 a link lasts 300 seconds — the one signed-link lifetime, not a second', () => {
      expect(RECRUITMENT.LINK_TTL_SECONDS).toBe(300);
      expect(RECRUITMENT.LINK_TTL_SECONDS).toBe(ASSET_LIMITS.SIGNED_URL_TTL_SECONDS);
    });

    it('P17-T4 AC-2 a pitch document is a PDF of at most 25 MB, in the office’s recruitment-pitch folder', () => {
      expect(DOCUMENT_MIME_TYPES).toEqual(['application/pdf']);
      expect(RECRUITMENT.PITCH_MIME_TYPES).toBe(DOCUMENT_MIME_TYPES);
      expect(RECRUITMENT.PITCH_MAX_BYTES).toBe(25 * 1024 * 1024);
      expect(RECRUITMENT.PITCH_MAX_BYTES).toBe(ASSET_LIMITS.MAX_BYTES);
      expect(RECRUITMENT.PITCH_UPLOAD_FOLDER).toBe('recruitment-pitch');
    });

    it('P17-T8 AC-2 each authored string is 1 to 600 characters, and a profile has 1 to 6 benefits', () => {
      expect(RECRUITMENT).toMatchObject({ TEXT_MIN_LENGTH: 1, TEXT_MAX_LENGTH: 600, BENEFITS_MIN: 1, BENEFITS_MAX: 6 });
    });
  });
});
