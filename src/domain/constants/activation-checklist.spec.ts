import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVATION_ACTIVITY_WEEKS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK,
  SEED_ACTIVATION_ASPECTS, SEED_ACTIVATION_ITEMS, activationLinkKind, mayTickByHand,
// Through the barrel, the way every caller reaches them.
} from '@/domain/constants';

/**
 * The seed against the frozen prototype (P5-T3 AC-2).
 *
 * Read out of the HTML rather than retyped: a checklist somebody transcribed by hand is a
 * checklist that drifts from the file it claims to copy, and the labels are what a new hire reads.
 */
const prototypeFile = (name: string) =>
  readFileSync(join(__dirname, `../../../../prototype/${name}`), 'utf8');

const AGENT_VIEW = prototypeFile('AgencyBoost_Overall.html');
const OWNER_TEMPLATE = prototypeFile('AgencyBoost_KPM_Owner.html');

/** `ACTIVATION_ASPECTS` in the agent's file — the same sixteen items, as a hire reads them. */
function prototypeItems(): string[] {
  const start = AGENT_VIEW.indexOf('const ACTIVATION_ASPECTS');
  const block = AGENT_VIEW.slice(start, AGENT_VIEW.indexOf('];', start));
  return [...block.matchAll(/text: "([^"]+)"/g)].map((m) => m[1]);
}

/** What the agent's file marks as auto-completing, in its own shorthand. */
function prototypeAutoKeys(): string[] {
  const start = AGENT_VIEW.indexOf('const ACTIVATION_ASPECTS');
  const block = AGENT_VIEW.slice(start, AGENT_VIEW.indexOf('];', start));
  return [...block.matchAll(/auto: "([^"]+)"/g)].map((m) => m[1]);
}

/** The Owner's settings screen — the document that defines the template (ADR-0031). */
function ownerAspectLabels(): string[] {
  const start = OWNER_TEMPLATE.indexOf('id="tab-settings-checklist"');
  const block = OWNER_TEMPLATE.slice(start, OWNER_TEMPLATE.indexOf('tab-settings-training', start));
  return [...block.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].replace('&amp;', '&'));
}

describe('the activation checklist seed (P5-T3)', () => {
  it('is the Owner template’s five aspects, in its order and with its numbering', () => {
    expect(SEED_ACTIVATION_ASPECTS.map((a) => a.label)).toEqual(ownerAspectLabels());
    expect(SEED_ACTIVATION_ASPECTS.map((a) => a.label)).toEqual([
      '1. Introduction',
      '2. Initial Setup',
      '3. Training & Certification',
      '4. First Sale',
      '5. Ongoing Habits',
    ]);
    expect(SEED_ACTIVATION_ASPECTS.map((a) => a.displayOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it('is sixteen items, each in an aspect that exists', () => {
    expect(SEED_ACTIVATION_ITEMS).toHaveLength(16);
    const aspects = new Set(SEED_ACTIVATION_ASPECTS.map((a) => a.code));
    for (const item of SEED_ACTIVATION_ITEMS) expect(aspects.has(item.aspectCode)).toBe(true);
  });

  it('carries the prototype’s wording, item for item', () => {
    const fromFile = prototypeItems();
    for (const item of SEED_ACTIVATION_ITEMS) {
      // Item 13 is the one deliberate difference, below.
      if (item.code === 'FIRST_CASE_CLOSED') continue;
      expect(fromFile).toContain(item.label);
    }
  });

  /*
   * ADR-0031. `Overall.html:6453` drops the last word, and the item before it is the one done
   * *with* a leader — so without it the two items describe the same afternoon. The Owner's
   * template is the document that defines the item, and it says "independently".
   */
  it('takes item 13’s wording from the Owner’s template, not the agent’s view', () => {
    const item = SEED_ACTIVATION_ITEMS.find((i) => i.code === 'FIRST_CASE_CLOSED')!;
    expect(item.label).toBe('Close first case independently');
    expect(prototypeItems()).toContain('Close first case');
  });

  it('numbers items within their aspect, and gives every one a distinct code', () => {
    const codes = SEED_ACTIVATION_ITEMS.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);

    for (const aspect of SEED_ACTIVATION_ASPECTS) {
      const orders = SEED_ACTIVATION_ITEMS
        .filter((i) => i.aspectCode === aspect.code)
        .map((i) => i.displayOrder);
      expect(orders).toEqual(orders.map((_, at) => at + 1));
    }
  });

  it('links exactly the three items the prototype marks auto, in its order', () => {
    expect(prototypeAutoKeys()).toEqual(['goal', 'leads', 'activity']);
  });

  it('binds each of those to the feature the item names', () => {
    const linked = SEED_ACTIVATION_ITEMS.filter((i) => i.autoLink !== null);
    expect(linked.map((i) => [i.code, i.autoLink])).toEqual([
      ['GOAL_SETTING', 'feature:goals'],
      ['ADD_PROSPECTS', 'feature:leads'],
      ['ACTIVITY_TRACKER_WEEKLY', 'feature:activity'],
    ]);
  });

  /*
   * The prototype's settings screen shows item 9 bound to module 7 as a demonstration
   * (`KPM_Owner.html:1546`). Which module an office means is the office's choice, and a seeded
   * link to a module it may archive would refuse its own provisioning.
   */
  it('seeds no training link', () => {
    expect(SEED_ACTIVATION_ITEMS.some((i) => i.autoLink?.startsWith('training:'))).toBe(false);
  });
});

describe('the link registry (P5-T3 AC-7)', () => {
  // `replaceProperty` below flips a flag on the real registry; this puts it back.
  afterEach(() => jest.restoreAllMocks());

  it('gives every feature kind a label, a route and the sentence it is waiting for', () => {
    expect(ACTIVATION_LINK_KINDS['feature:goals']).toMatchObject({
      label: 'Goal Settings', route: '/goals', livePhase: 11,
    });
    expect(ACTIVATION_LINK_KINDS['feature:leads']).toMatchObject({
      label: 'Leads Management', route: '/leads', livePhase: 11,
    });
    expect(ACTIVATION_LINK_KINDS['feature:activity']).toMatchObject({
      label: 'Activity Management', route: '/activity/log', livePhase: 11,
    });
    for (const kind of Object.values(ACTIVATION_LINK_KINDS)) {
      expect(kind.completesWhen.length).toBeGreaterThan(10);
      expect(kind.route.startsWith('/')).toBe(true);
    }
  });

  it('waits four weeks for the activity link, because the item says weekly (ADR-0031)', () => {
    expect(ACTIVATION_ACTIVITY_WEEKS).toBe(4);
    expect(ACTIVATION_LINK_KINDS['feature:activity'].completesWhen).toContain('four consecutive weeks');
  });

  it('resolves a training link by its prefix, and refuses one with no module code', () => {
    expect(activationLinkKind('training:PROSPECT_LIST')).toBe(ACTIVATION_TRAINING_LINK);
    expect(activationLinkKind('training:')).toBeUndefined();
    expect(activationLinkKind('feature:whatever')).toBeUndefined();
    expect(activationLinkKind(null)).toBeUndefined();
  });

  /*
   * ADR-0031. No evaluator exists in Phase 5, so an item bound to a link must stay tickable —
   * otherwise nobody bound to one could ever reach 100%. The moment a kind goes live the answer
   * flips, for every role, and this test is what will catch the flag being set without the rule
   * being honoured.
   */
  it('lets a leader tick an item by hand until its evaluator is live', () => {
    expect(mayTickByHand(null)).toBe(true);
    expect(mayTickByHand('feature:goals')).toBe(true);
    expect(mayTickByHand('training:PROSPECT_LIST')).toBe(true);
  });

  it('stops letting anybody tick it the moment that kind goes live', () => {
    // The flag flips in Phase 11, and this is the rule that has to follow it. Flipped here
    // rather than asserted in prose, so the day somebody sets `live` the behaviour is proven.
    jest.replaceProperty(ACTIVATION_LINK_KINDS['feature:goals'] as { live: boolean }, 'live', true);

    expect(mayTickByHand('feature:goals')).toBe(false);
    // Its neighbours are untouched: the rule is per kind, not per product.
    expect(mayTickByHand('feature:leads')).toBe(true);
    expect(mayTickByHand(null)).toBe(true);
  });

  it('declares no kind live yet, and says which phase makes each one live', () => {
    for (const kind of [...Object.values(ACTIVATION_LINK_KINDS), ACTIVATION_TRAINING_LINK]) {
      expect(kind.live).toBe(false);
    }
    expect(ACTIVATION_TRAINING_LINK.livePhase).toBe(12);
  });
});
