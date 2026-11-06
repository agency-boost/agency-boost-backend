import mongoose from 'mongoose';

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface CampaignKindsResult {
  /** Campaigns given a field they lacked this run. */
  updated: number;
  /** Campaigns that already carried every one — a second run, or a campaign written since. */
  current: number;
}

/**
 * The defaults, written out rather than read from the constants module, so this migration says the same thing on
 * every run whatever the constants become: a seasonal campaign over its own dates, open to everybody, with the
 * default poster and no blurb (`DEFAULT_CAMPAIGN_POSTER` at the time of writing).
 */
const DEFAULTS: Readonly<Record<string, unknown>> = {
  kind: 'seasonal',
  subtype: null,
  window: 'campaign_dates',
  appliesToOrgLevelCodes: [],
  poster: { emoji: '🎯', color: 'navy' },
  blurb: '',
};

/**
 * **The fields the agent's campaign card draws, for every campaign written before them** (Phase 18.2, P18.2-T7 AC-9;
 * D-fields).
 *
 * `Overall.html`'s card draws a kind, a section, a poster, a blurb and *Ongoing* programmes with no end
 * (`:3664-3702`, `:8040-8074`); Phase 5's campaign held none of them. Every existing campaign was written as a dated
 * contest, so it becomes what it was: **seasonal**, read over **its own dates**, open to **every rung**, with the
 * default poster and an empty blurb. Its dates are not touched — snapping one to whole months is the Owner's
 * decision (the demo seed does it for its own), and a campaign whose requirements read the monthly file keeps
 * evaluating over the months its dates fall in.
 *
 * **Touches each office's own campaigns and nothing else. Idempotent**: only a field a row lacks is written, so a
 * second run, or a campaign written since, is left as it is — an Owner's poster is never overwritten.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<CampaignKindsResult> {
  const campaigns = db.collection('campaigns');
  const result: CampaignKindsResult = { updated: 0, current: 0 };

  const rows = await campaigns
    .find({}, { projection: { kind: 1, subtype: 1, window: 1, appliesToOrgLevelCodes: 1, poster: 1, blurb: 1 } })
    .sort({ _id: 1 })
    .toArray();

  for (const row of rows) {
    const set: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(DEFAULTS)) {
      if (!(field in row)) set[field] = value;
    }
    if (Object.keys(set).length === 0) {
      result.current += 1;
      continue;
    }
    // Timestamps by hand: this update has no Mongoose in between to stamp it.
    await campaigns.updateOne({ _id: row._id }, { $set: { ...set, updatedAt: now } });
    result.updated += 1;
  }

  return result;
}
