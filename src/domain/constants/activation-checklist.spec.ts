import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVATION_ACTIVITY_WEEKS, ACTIVATION_LINK_KINDS, ACTIVATION_TRAINING_LINK,
  SEED_ACTIVATION_ASPECTS, SEED_ACTIVATION_ITEMS, activationLinkKind, mayTickByHand, ACTIVATION_FIRST_CASE_CODE,
  ACTIVATION_CODE_BOUND_LINKS, ACTIVATION_DATA_LINK_KINDS, ACTIVATION_DATA_LINKS, ACTIVATION_INDEPENDENT_CLOSINGS,
  ACTIVATION_WEEKLY_CHECK_INS, FIRST_SALE_STAGE_CODE, dataItemHandWrite, effectiveAutoLink, isActivationDataLink,
  recordFormOf, SEED_LEAD_STATUSES,
// Through the barrel, the way every caller reaches them.
} from '@/domain/constants';
// Only migration 0046 and the specs read it, so the barrel does not carry it.
import { SEEDED_ACTIVATION_LABELS_BEFORE_OD_238 } from './activation-checklist';

/**
 * **The seed in the prototype's English** (P18.10-T7, OD-238): the words it gave before it was written in Bahasa
 * Indonesia, by code. What the prototype is compared against; the Indonesian is pinned word for word below.
 */
const WAS = SEEDED_ACTIVATION_LABELS_BEFORE_OD_238;
const englishAspect = (a: { code: string }) => WAS.aspects[a.code];
const englishItem = (i: { code: string }) => WAS.items[i.code];

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
    expect(SEED_ACTIVATION_ASPECTS.map(englishAspect)).toEqual(ownerAspectLabels());
    expect(SEED_ACTIVATION_ASPECTS.map(englishAspect)).toEqual([
      '1. Introduction',
      '2. Initial Setup',
      '3. Training & Certification',
      '4. First Sale',
      '5. Ongoing Habits',
    ]);
    expect(SEED_ACTIVATION_ASPECTS.map((a) => a.displayOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  /*
   * **The platform's Default template in Bahasa Indonesia** (P18.10-T7; OD-238, option 1; ADR-0179 §5): what every new
   * hire reads, pinned word for word — *goal*, *leader*, *closing*, *case*, *1-on-1*, *milestone*, *Leads Management*
   * and *Activity Tracker* kept English by the approved glossary — and the English recorded for migration 0046 is
   * exactly what changed, every code once.
   */
  it('P18.10-T7 writes the five aspects and the sixteen items in Bahasa Indonesia', () => {
    expect(SEED_ACTIVATION_ASPECTS.map((a) => a.label)).toEqual([
      '1. Pengenalan', '2. Persiapan awal', '3. Pelatihan & sertifikasi', '4. Penjualan pertama', '5. Kebiasaan rutin',
    ]);
    expect(SEED_ACTIVATION_ITEMS.map((i) => i.label)).toEqual([
      'Pelajari dasar-dasar asuransi',
      'Pelajari pola pikir karier keagenan',
      'Pelajari profil perusahaan',
      'Ikuti sesi pengenalan KPM',
      'Atur goal: target APE & aktivitas',
      'Siapkan sistem CRM perusahaan',
      'Tambahkan prospek di Leads Management',
      'Cek kontes terdekat',
      'Pelatihan wajib: keterampilan menjual & pengetahuan produk',
      'Sertifikasi produk prioritas',
      'Role play dengan leader',
      'Joint field work dengan leader',
      'Closing case pertama secara mandiri',
      'Isi Activity Tracker setiap minggu',
      'Check-in 1-on-1 mingguan (4 minggu)',
      'Capai milestone agen mandiri (3 kali closing secara mandiri)',
    ]);
    expect(Object.keys(WAS.aspects)).toEqual(SEED_ACTIVATION_ASPECTS.map((a) => a.code));
    expect(Object.keys(WAS.items)).toEqual(SEED_ACTIVATION_ITEMS.map((i) => i.code));
    for (const item of SEED_ACTIVATION_ITEMS) expect(englishItem(item)).not.toBe(item.label);
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
      expect(fromFile).toContain(englishItem(item));
    }
  });

  /*
   * ADR-0031. `Overall.html:6453` drops the last word, and the item before it is the one done
   * *with* a leader — so without it the two items describe the same afternoon. The Owner's
   * template is the document that defines the item, and it says "independently".
   */
  it('takes item 13’s wording from the Owner’s template, not the agent’s view', () => {
    const item = SEED_ACTIVATION_ITEMS.find((i) => i.code === 'FIRST_CASE_CLOSED')!;
    expect(englishItem(item)).toBe('Close first case independently');
    // In Bahasa Indonesia since P18.10-T7, *independently* kept: *secara mandiri*.
    expect(item.label).toBe('Closing case pertama secara mandiri');
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
      expect(kind.route?.startsWith('/')).toBe(true);
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
  it('P13-T3 AC-1 lets anybody tick a manual item', () => {
    expect(mayTickByHand(null)).toBe(true);
    expect(mayTickByHand(null, false)).toBe(true);
  });

  it('P18.2-T3 AC-1 lets nobody tick a training-linked item while its module is offered: the evaluator exists', () => {
    expect(mayTickByHand('training:PROSPECT_LIST')).toBe(false);
    expect(mayTickByHand('training:PROSPECT_LIST', true)).toBe(false);
  });

  it('P18.2-T3 AC-4 D-orphan: a training-linked item is ticked by hand while its module is not offered', () => {
    expect(mayTickByHand('training:CLIENT_RETENTION', false)).toBe(true);
    // `offered` is a training link's question alone: a feature link binds no module.
    expect(mayTickByHand('feature:goals', false)).toBe(false);
  });

  it('P18.2 exit review (training review 1) an item its link completed is never hand-edited, whatever its link now', () => {
    expect(mayTickByHand('training:CLIENT_RETENTION', false, true)).toBe(false);
    expect(mayTickByHand('training:', true, true)).toBe(false);
    expect(mayTickByHand(null, true, true)).toBe(false);
    expect(mayTickByHand('training:CLIENT_RETENTION', false, false)).toBe(true);
  });

  it('P18.2-T3 AC-1 an item linked to a kind nothing declares is ticked by hand, offered or not', () => {
    expect(mayTickByHand('training:', true)).toBe(true);
    expect(mayTickByHand('feature:whatever', false)).toBe(true);
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
      aspectCode: 'FIRST_SALE', label: 'Closing case pertama secara mandiri', autoLink: null,
    });
  });

  it('P18.2-T3 AC-1 declares every kind live: the three feature kinds, and the training link since its evaluator', () => {
    for (const kind of Object.values(ACTIVATION_LINK_KINDS)) {
      expect(kind.live).toBe(true);
    }
    expect(ACTIVATION_TRAINING_LINK).toMatchObject({
      live: true, route: '/training', completesWhen: 'the hire has completed that training module',
    });
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

/** P18.8-T4 (ADR-0171 §3): the three data-backed items, bound by code, ticked by hand only with their record. */
describe('the data-backed items (P18.8-T4 AC-2, AC-3)', () => {
  it('P18.8-T4 AC-2 binds the platform’s three items by code, and the words the items carry say what each waits for', () => {
    expect(ACTIVATION_CODE_BOUND_LINKS).toEqual({
      FIRST_CASE_CLOSED: 'sales:first', INDEPENDENT_AGENT_MILESTONE: 'sales:closings:3', WEEKLY_CHECK_IN: 'coaching:weekly:4',
    });
    // Each bound code is a seeded item, and its label holds the number its kind counts to.
    const labels = new Map(SEED_ACTIVATION_ITEMS.map((i) => [i.code, i.label]));
    expect(Object.keys(ACTIVATION_CODE_BOUND_LINKS).every((code) => labels.has(code))).toBe(true);
    expect(labels.get('INDEPENDENT_AGENT_MILESTONE')).toContain(`${ACTIVATION_INDEPENDENT_CLOSINGS} kali closing`);
    expect(labels.get('WEEKLY_CHECK_IN')).toContain(`${ACTIVATION_WEEKLY_CHECK_INS} minggu`);
    expect(ACTIVATION_FIRST_CASE_CODE).toBe('FIRST_CASE_CLOSED');
  });

  it('P18.8-T4 AC-2 pins the constants: three closings, four 1:1s, and the sales ladder’s Paid and issued by its code', () => {
    expect([ACTIVATION_INDEPENDENT_CLOSINGS, ACTIVATION_WEEKLY_CHECK_INS, FIRST_SALE_STAGE_CODE]).toEqual([3, 4, 'PAID_AND_ISSUED']);
    expect(SEED_LEAD_STATUSES.find((s) => s.code === FIRST_SALE_STAGE_CODE)).toMatchObject({ pipeline: 'sales', isTerminal: true });
  });

  it('P18.8-T4 AC-2 reads an item’s own link first, else the kind its code is bound to, else none — the seed stores none', () => {
    expect(effectiveAutoLink('FIRST_CASE_CLOSED', null)).toBe('sales:first');
    expect(effectiveAutoLink('WEEKLY_CHECK_IN', null)).toBe('coaching:weekly:4');
    // An office's own choice for the item stays.
    expect(effectiveAutoLink('FIRST_CASE_CLOSED', 'feature:leads')).toBe('feature:leads');
    expect(effectiveAutoLink('CRM_SETUP', null)).toBeNull();
    expect(effectiveAutoLink('toString', null)).toBeNull();
    for (const code of Object.keys(ACTIVATION_CODE_BOUND_LINKS)) {
      expect(SEED_ACTIVATION_ITEMS.find((i) => i.code === code)!.autoLink).toBeNull();
    }
  });

  it('P18.8-T4 AC-2 registers each data kind live, with its source line’s words, no route, and its form', () => {
    expect(ACTIVATION_DATA_LINKS).toEqual(['sales:first', 'sales:closings:3', 'coaching:weekly:4']);
    expect(ACTIVATION_DATA_LINK_KINDS['sales:first']).toMatchObject({ label: 'Sales data', route: null, live: true, form: 'closing' });
    expect(ACTIVATION_DATA_LINK_KINDS['sales:closings:3']).toMatchObject({ label: 'Sales data', form: 'closing' });
    expect(ACTIVATION_DATA_LINK_KINDS['coaching:weekly:4']).toMatchObject({ label: 'Coaching sessions', form: 'one_on_one' });
    for (const link of ACTIVATION_DATA_LINKS) {
      expect(isActivationDataLink(link)).toBe(true);
      expect(activationLinkKind(link)).toBe(ACTIVATION_DATA_LINK_KINDS[link]);
      // Live, so a bare hand tick is refused like any live link's — `dataItemHandWrite` is the way in.
      expect(mayTickByHand(link)).toBe(false);
    }
    expect(isActivationDataLink('feature:goals')).toBe(false);
    expect(isActivationDataLink(null)).toBe(false);
    expect(recordFormOf('sales:first')).toBe('closing');
    expect(recordFormOf('coaching:weekly:4')).toBe('one_on_one');
    expect(recordFormOf('feature:goals')).toBeNull();
  });

  it('P18.8-T4 AC-3 a hand write to a data item: a tick needs its record, an untick is free, one its data completed is refused', () => {
    expect(dataItemHandWrite('sales:first', true, false)).toBe('needs_record');
    expect(dataItemHandWrite('coaching:weekly:4', false, false)).toBe('free');
    expect(dataItemHandWrite('sales:closings:3', true, true)).toBe('refused');
    expect(dataItemHandWrite('sales:closings:3', false, true)).toBe('refused');
    // Any other link is `mayTickByHand`'s.
    expect(dataItemHandWrite('feature:leads', true, false)).toBeNull();
    expect(dataItemHandWrite(null, true, false)).toBeNull();
  });
});
