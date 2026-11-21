import { platformAnalyticsConfig } from '@/modules/config/analytics-config';
import { snapshotOf } from './survey-opening';
import { issueTilesOf, personSections } from './survey-person';
import { previewOf, sendablePeriod } from './survey-runs.service';

/**
 * ***Survei baru*** and *Per orang*'s tiles, pure (P19.22-T6 AC-3, T7 AC-3, AC-4; ADR-0276 §2, §5): the period a run is
 * sent for, what the preview lists, and *Item bermasalah* counted per item.
 */
const config = platformAnalyticsConfig();
const published = { templateId: null, templateName: null, version: 1, config };

describe('P19.22 ADR-0276 §2 Survei baru', () => {
  it('P19.22-T6 AC-3 NPS is sent for today’s quarter, opening today', () => {
    expect(sendablePeriod('nps', '2026-11-20', config)).toEqual({ periodKey: '2026-Q4', opensOn: '2026-11-20' });
    expect(sendablePeriod('nps', '2027-01-01', { ...config, nps: { ...config.nps, cadence: 'half' } }))
      .toEqual({ periodKey: '2027-H1', opensOn: '2027-01-01' });
  });

  it('P19.22-T7 AC-4 a qualitative run: June or December, today in one of them, else the next, opening on its first day', () => {
    expect(sendablePeriod('qual', '2026-11-20', config)).toEqual({ periodKey: '2026-12', opensOn: '2026-12-01' });
    expect(sendablePeriod('qual', '2026-12-05', config)).toEqual({ periodKey: '2026-12', opensOn: '2026-12-05' });
    expect(sendablePeriod('qual', '2027-01-10', config)).toEqual({ periodKey: '2027-06', opensOn: '2027-06-01' });
  });

  it('P19.22-T6 AC-3 the NPS preview: the five questions and the open one', () => {
    const lines = previewOf('nps', snapshotOf({ kind: 'nps', anonymous: true, perPerson: false }, published));
    expect(lines.map((l) => [l.kodes.join(','), l.type])).toEqual([
      ['P1', 'score'], ['P2', 'score'], ['P3', 'score'], ['P4', 'score'], ['P5', 'score'], ['OPEN', 'text'],
    ]);
  });

  it('P19.22-T7 AC-4 the qualitative preview: profile facts are never asked; Q8–Q9 one line; leader blocks marked', () => {
    const lines = previewOf('qual', snapshotOf({ kind: 'qual', anonymous: false, perPerson: true }, published));
    expect(lines.map((l) => [l.kodes.join('–'), l.audience, l.items])).toEqual([
      ['Q4', 'all', 4], ['Q5', 'all', 7], ['Q6', 'leader', 8], ['Q7', 'leader', 7], ['Q8–Q9', 'leader', 8],
      ['Q10–Q11', 'leader', 4], ['Q12', 'all', 0],
    ]);
    expect(lines.find((l) => l.kodes[0] === 'Q8')!.type).toBe('unit_items');
  });
});

describe('P19.22-T7 AC-3 QUAL_PERSON_ISSUE_ITEMS', () => {
  it('P19.22-T7 AC-3 a unit item is a problem once, by its consistency or its comfort: x/8, never x/16', () => {
    const snap = snapshotOf({ kind: 'qual', anonymous: false, perPerson: true }, published);
    const unit = snap.blocks.find((b) => b.kode === 'UNIT')!;
    const kodes = unit.questions[0].items.map((i) => i.kode);
    const form = {
      answers: [
        { questionKode: 'Q8', value: Object.fromEntries(kodes.map((k, i) => [k, i < 3 ? 'inconsistent' : 'consistent'])) },
        { questionKode: 'Q9', value: Object.fromEntries(kodes.map((k, i) => [k, i < 2 || i === 7 ? 2 : 5])) },
      ],
    };
    const tiles = issueTilesOf(personSections([unit], form, { company: 'Prudential', kpm: 'KPM 0417' }, new Map()), 3);
    // Items 0–2 inconsistent, items 0, 1 and 7 uncomfortable: 0, 1, 2 and 7 — four of eight.
    expect(tiles).toEqual([{ kode: 'UNIT', title: unit.title, count: 4, of: 8 }]);
  });
});
