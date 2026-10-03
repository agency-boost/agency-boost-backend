import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVATION_ACTIVITY_WEEKS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK,
  SEED_ACTIVATION_ASPECTS, SEED_ACTIVATION_ITEMS, activationLinkKind, mayTickByHand, ACTIVATION_FIRST_CASE_CODE,
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
      label: 'Goal Settings', route: '/goals',
    });
    expect(ACTIVATION_LINK_KINDS['feature:leads']).toMatchObject({
      label: 'Leads Management', route: '/leads',
    });
    expect(ACTIVATION_LINK_KINDS['feature:activity']).toMatchObject({
      label: 'Activity Management', route: '/activity/log',
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
   * ADR-0031. An item bound to a link nobody evaluates must stay tickable — otherwise nobody bound to
   * one could ever reach 100%. The moment a kind goes live the answer flips, for every role.
   */
  it('P13-T3 AC-1 lets anybody tick a manual item, and a training-linked one until its evaluator exists', () => {
    expect(mayTickByHand(null)).toBe(true);
    expect(mayTickByHand('training:PROSPECT_LIST')).toBe(true);
  });

  it('P13-T3 AC-1 lets nobody tick an item whose link is live: the three feature kinds', () => {
    expect(mayTickByHand('feature:goals')).toBe(false);
    expect(mayTickByHand('feature:leads')).toBe(false);
    expect(mayTickByHand('feature:activity')).toBe(false);
  });

  it('P13-T3 AC-1 the rule is per kind: a kind flipped back to not live is tickable again, its neighbours untouched', () => {
    jest.replaceProperty(ACTIVATION_LINK_KINDS['feature:goals'] as { live: boolean }, 'live', false);

    expect(mayTickByHand('feature:goals')).toBe(true);
    expect(mayTickByHand('feature:leads')).toBe(false);
    expect(mayTickByHand(null)).toBe(true);
  });

  /*
   * D-copy (ADR-0084, ADR-0096): a string the module writes itself uses none of the six words, and the
   * *Auto* badge shows each `completesWhen` to the hire as its tooltip (P13-T4 AC-4).
   */
  it('P13-T4 AC-4 no link’s words use any of the six: office, KPM, reports to, tagged to, untagged, unassigned', () => {
    const SIX = /\boffice\b|\bKPM\b|reports to|tagged to|\buntagged\b|\bunassigned\b/i;
    for (const kind of [...Object.values(ACTIVATION_LINK_KINDS), ACTIVATION_TRAINING_LINK]) {
      expect([kind.completesWhen, SIX.test(kind.completesWhen)]).toEqual([kind.completesWhen, false]);
      expect([kind.label, SIX.test(kind.label)]).toEqual([kind.label, false]);
    }
    expect(ACTIVATION_LINK_KINDS['feature:goals'].completesWhen).toBe('the hire has saved any goal since joining');
  });

  it('P13-T5 AC-2 the Active Agent column’s code is a seeded item: FIRST_CASE_CLOSED, never item 13', () => {
    expect(ACTIVATION_FIRST_CASE_CODE).toBe('FIRST_CASE_CLOSED');
    expect(SEED_ACTIVATION_ITEMS.find((i) => i.code === ACTIVATION_FIRST_CASE_CODE)).toMatchObject({
      aspectCode: 'FIRST_SALE', label: 'Close first case independently', autoLink: null,
    });
  });

  it('P13-T3 AC-1 declares the three feature kinds live and the training link not', () => {
    for (const kind of Object.values(ACTIVATION_LINK_KINDS)) {
      expect(kind.live).toBe(true);
    }
    expect(ACTIVATION_TRAINING_LINK.live).toBe(false);
  });

  /*
   * P10.1-T2 AC-13. Each kind carried `livePhase` — 11 or 12, the old plan's — for a screen to print
   * *"starts working in phase {n}"*. A phase number is our schedule (ADR-0062 §3), and the re-plan
   * made these wrong without a test noticing. Pinned by the whole shape, so a schedule field added
   * back under any name fails here, not on a customer's screen.
   */
  it('says whether a kind is live and never when: no phase number is carried', () => {
    for (const kind of [...Object.values(ACTIVATION_LINK_KINDS), ACTIVATION_TRAINING_LINK]) {
      expect(Object.keys(kind).sort()).toEqual(['completesWhen', 'label', 'live', 'route']);
    }
  });
});
