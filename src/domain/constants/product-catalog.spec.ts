import {
  APPROVED_PRODUCT_FIELDS, OVERRIDABLE_PRODUCT_FIELDS, PRODUCT_AGE_BANDS, PRODUCT_AGE_BAND_LABELS,
  PRODUCT_BUDGET_BANDS, PRODUCT_BUDGET_BAND_LABELS, PRODUCT_CATEGORIES, PRODUCT_CHANNELS,
  PRODUCT_LIFECYCLES, PRODUCT_NEEDS, PRODUCT_TAGLINE_MAX_LENGTH, SCRIPT_OVERRIDE_FIELDS,
  SEED_PRODUCTS, SEED_REPLY_BY_NEED,
} from '@/domain/constants';

/**
 * The catalog a company starts with (P5-T4).
 *
 * Generated from the frozen prototypes, so what this pins is the **merge** — which file each field
 * came from, and the distribution the catalog screen shows. A regeneration that quietly changed one
 * fails here rather than reaching a company's shelf.
 */
describe('the seeded product catalog (P5-T4)', () => {
  /** The two the prototype flags `legacy: true`, and the only two with no authored script. */
  const RUN_OFF = ['PRULINK_GENERASI_BARU_PGB', 'PRULINK_SYARIAH_GENERASI_BARU_PSGB'];

  it('is the 31 products of Sales_Catalog.html, in its order', () => {
    expect(SEED_PRODUCTS).toHaveLength(31);
    expect(SEED_PRODUCTS.map((p) => p.sortOrder)).toEqual(
      Array.from({ length: 31 }, (_, i) => i + 1),
    );
  });

  it('holds the distribution the catalog screen shows', () => {
    const count = (key: 'category' | 'channel') => SEED_PRODUCTS.reduce<Record<string, number>>(
      (acc, p) => ({ ...acc, [p[key]]: (acc[p[key]] ?? 0) + 1 }), {},
    );

    expect(count('category')).toEqual({
      life: 10, health: 10, ci: 4, education: 1, investment: 6,
    });
    expect(count('channel')).toEqual({ conventional: 15, syariah: 16 });
  });

  it('gives every product a code that is unique, upper case and never a display name', () => {
    const codes = SEED_PRODUCTS.map((p) => p.code);

    expect(new Set(codes).size).toBe(31);
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    // The prototype keys by the display name — `PRULink Generasi Baru (PGB)`, spaces and
    // parentheses and all — which is the defect ADR-0006 exists to prevent.
    expect(codes).not.toContain('PRULink Generasi Baru (PGB)');
  });

  it('carries exactly one primary need per product, from the prototype’s eight', () => {
    for (const product of SEED_PRODUCTS) {
      expect(product.primaryNeeds).toHaveLength(1);
      expect(PRODUCT_NEEDS).toContain(product.primaryNeeds[0]);
    }
  });

  it('files accident products under health, because accident is a need and not a category', () => {
    const accident = SEED_PRODUCTS.filter((p) => p.primaryNeeds.includes('accident'));

    expect(accident).toHaveLength(2);
    for (const product of accident) expect(product.category).toBe('health');
  });

  it('scores every product on the seven-band budget scale of the Overall.html copy', () => {
    // The one place the prototype's copies disagree in *meaning*: `Sales_Attack_Plan.html` scores
    // the same 31 products on five bands, its fourth swallowing three of these. The ERD and the
    // flow doc record seven, and the coarser scale throws away the Rp5–10M / 10–20M / >20M split.
    expect(PRODUCT_BUDGET_BANDS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(PRODUCT_AGE_BANDS).toEqual([1, 2, 3, 4, 5]);

    const used = new Set(SEED_PRODUCTS.flatMap((p) => p.eligibleBudgetBands));
    expect([...used].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    for (const product of SEED_PRODUCTS) {
      expect(product.eligibleAgeBands.length).toBeGreaterThan(0);
      expect(product.eligibleBudgetBands.length).toBeGreaterThan(0);
      for (const band of product.eligibleAgeBands) expect(PRODUCT_AGE_BANDS).toContain(band);
      for (const band of product.eligibleBudgetBands) expect(PRODUCT_BUDGET_BANDS).toContain(band);
    }
  });

  it('labels every band, so a screen never renders a bare number', () => {
    for (const band of PRODUCT_AGE_BANDS) expect(PRODUCT_AGE_BAND_LABELS[band]).toBeTruthy();
    for (const band of PRODUCT_BUDGET_BANDS) expect(PRODUCT_BUDGET_BAND_LABELS[band]).toBeTruthy();
  });

  it('marks the two products the prototype flags as legacy as closed to new business (AC-4)', () => {
    const runOff = SEED_PRODUCTS.filter((p) => p.lifecycle !== 'active');

    expect(runOff.map((p) => p.code))
      .toEqual(['PRULINK_GENERASI_BARU_PGB', 'PRULINK_SYARIAH_GENERASI_BARU_PSGB']);
    for (const product of runOff) {
      expect(product.lifecycle).toBe('closed_to_new_business');
      // Nobody's office starts selling a product in run-off.
      expect(product.activeByDefault).toBe(false);
    }
    expect(SEED_PRODUCTS.filter((p) => p.activeByDefault)).toHaveLength(29);
  });

  it('leaves the script fields of the two run-off products blank rather than inventing copy', () => {
    // They have no authored script in the prototype. A blank is honest; invented copy is not.
    for (const code of RUN_OFF) {
      const plan = SEED_PRODUCTS.find((p) => p.code === code)!.defaultAttackPlan;
      expect(plan.opening).toBe('');
      expect(plan.fullScript).toBe('');
      expect(plan.nextAction).toBe('');
      // The fields that do not need a script are still filled.
      expect(plan.goodFit).not.toBe('');
      expect(plan.benefits.length).toBeGreaterThan(0);
    }
  });

  it('fills the other 29 attack plans from the prototype’s own extraction rules', () => {
    for (const product of SEED_PRODUCTS.filter((p) => !RUN_OFF.includes(p.code))) {
      const plan = product.defaultAttackPlan;

      expect(plan.goodFit).toBe(product.bestFor);
      expect(plan.benefits).toEqual(product.benefits);
      // `extractOpening` is everything up to the first bold, `extractClosing` the last bolded
      // question — both of which have to be part of the script they were taken from.
      expect(plan.fullScript).toContain(plan.opening);
      expect(plan.fullScript).toContain(plan.nextAction);
      expect(plan.nextAction).toMatch(/\?$/);
      expect(plan.objectionTheySay).not.toBe('');
    }
  });

  it('answers the push-back with the need’s reply Overall.html renders, not the differentiator (D-reply)', () => {
    // `REPLY_BY_NEED` (`Overall.html:9497-9506`), keyed by the product's first need as the
    // prototype keys it (`:9728`, `:10287`). The comment above the table says the differentiator,
    // which is what P5-T4 seeded; the differentiator prints under *How it stands out* already.
    for (const product of SEED_PRODUCTS) {
      const need = product.primaryNeeds[0];
      expect(product.defaultAttackPlan.objectionYouSay).toBe(SEED_REPLY_BY_NEED[need]);
      expect(product.defaultAttackPlan.objectionYouSay).not.toBe(product.differentiator);
    }
    // Verbatim, and the same words the Owner's own modal ships for PRUmapan (`KPM_Owner.html:2326`).
    expect(SEED_REPLY_BY_NEED.retirement).toBe(
      "I hear that a lot — it doesn't feel urgent yet. But that's actually the best reason to start "
      + 'now: the earlier you begin, the less it costs you each month to get to the same place later. '
      + "This isn't about retiring tomorrow, it's about giving your future self a lot less to worry about.",
    );
  });

  it('has a reply for every need, so no product is left without one', () => {
    expect(Object.keys(SEED_REPLY_BY_NEED).sort()).toEqual([...PRODUCT_NEEDS].sort());
    for (const reply of Object.values(SEED_REPLY_BY_NEED)) expect(reply.length).toBeGreaterThan(0);
  });

  it('holds the description for approval with the seven script fields, and the name for nobody (OD-136)', () => {
    expect(SCRIPT_OVERRIDE_FIELDS).toEqual([
      'goodFit', 'opening', 'benefits', 'fullScript', 'objectionTheySay', 'objectionYouSay',
      'nextAction',
    ]);
    expect(APPROVED_PRODUCT_FIELDS).toEqual(['description', ...SCRIPT_OVERRIDE_FIELDS]);
    expect(OVERRIDABLE_PRODUCT_FIELDS).toEqual(['displayName', ...APPROVED_PRODUCT_FIELDS]);
    expect(APPROVED_PRODUCT_FIELDS).not.toContain('displayName');
  });

  it('bounds the office’s description by the company tagline’s own bound', () => {
    expect(PRODUCT_TAGLINE_MAX_LENGTH).toBe(300);
    for (const product of SEED_PRODUCTS) {
      expect(product.tagline.length).toBeLessThanOrEqual(PRODUCT_TAGLINE_MAX_LENGTH);
    }
  });

  it('carries no markup, in any field a screen renders', () => {
    // The prototype encodes the script's structure in `<b>` tags and renders it through
    // `innerHTML`. Nothing authored reaches a screen as markup again (AC-7).
    const text = SEED_PRODUCTS.flatMap((p) => [
      p.name, p.tagline, p.differentiator, p.bestFor, ...p.benefits,
      ...Object.values(p.defaultAttackPlan).flat(),
    ]);

    for (const value of text) expect(String(value)).not.toMatch(/<[a-z/]/i);
  });

  it('carries no commission schedule at all (parity F-15)', () => {
    // The prototype's drawer falls back to a fabricated 40% / 20%. A figure an agent reads as
    // their pay is the company's to state, so the seed has no field for one.
    for (const product of SEED_PRODUCTS) {
      expect(product).not.toHaveProperty('commissionSchedule');
    }
  });

  it('uses only the declared channels, categories and lifecycles', () => {
    for (const product of SEED_PRODUCTS) {
      expect(PRODUCT_CHANNELS).toContain(product.channel);
      expect(PRODUCT_CATEGORIES).toContain(product.category);
      expect(PRODUCT_LIFECYCLES).toContain(product.lifecycle);
    }
  });
});
