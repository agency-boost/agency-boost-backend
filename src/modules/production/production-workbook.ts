import { formatNumber } from '@/common/format/format';
import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { writeWorkbook } from '@/common/spreadsheet/write-xlsx';
import { PRODUCTION_METRICS, type ProductionMetric } from './monthly-agent-data.schema';
import { TEMPLATE_HEADER_V1 } from './production-template';
import { PRODUCTION_TEMPLATE_WORDS } from './production-template.messages';

/*
 * **The template as an Excel workbook** (ADR-0184), apart from `production-template.ts`, which is the file's contract
 * and takes no language (P18.98-T3 AC-4, pinned by the frontend's `lib/production.spec.ts`): the header and the rows
 * are that file's; only the guide beside them is written for a reader.
 */

/** Each metric's guide sentence. */
const METRIC_WORDS = {
  ape: PRODUCTION_TEMPLATE_WORDS.ape,
  persistency: PRODUCTION_TEMPLATE_WORDS.persistency,
  recruitment: PRODUCTION_TEMPLATE_WORDS.recruitment,
  newActiveAgents: PRODUCTION_TEMPLATE_WORDS.newActiveAgents,
  fyp: PRODUCTION_TEMPLATE_WORDS.fyp,
  policyCount: PRODUCTION_TEMPLATE_WORDS.policyCount,
} as const satisfies Record<ProductionMetric, unknown>;

/** A value each metric's column would take, as a reader of either language types it. */
const METRIC_EXAMPLE: Record<ProductionMetric, number> = {
  ape: 1.5, persistency: 85, recruitment: 2, newActiveAgents: 1, fyp: 1.2, policyCount: 3,
};

/**
 * **The month's template as a workbook** (ADR-0184): the *Petunjuk* (*Guide*) sheet in the reader's language, and the
 * **Data** sheet — the same fourteen-column header as the CSV, and the same rows, one per active agent with the code and
 * the name and twelve empty cells.
 *
 * **The code column is text**, so a code keeps its leading zeros however the person's spreadsheet is set up — the
 * defect ADR-0052 forgives in a CSV is not made in the first place. **A name is a string**, never a formula, so it needs
 * no leading apostrophe here: the CSV's `csvName` guards a format that is read as formulas, and a workbook's cell is
 * whatever type it is written as. It is still made one line.
 */
export function templateWorkbook(
  rows: readonly { agentCode: string; name: string }[],
  month: string,
  reader: Reader,
): Promise<Buffer> {
  const say = (message: Parameters<typeof render>[0]) => render(message, reader);
  const example = (metric: ProductionMetric) => formatNumber(METRIC_EXAMPLE[metric], undefined, reader.language);
  // The header's order: the six monthly, then the same six YTD.
  const valueColumns = (['monthly', 'ytd'] as const).flatMap((cadence) => PRODUCTION_METRICS.map((metric) => ({ metric, cadence })));

  return writeWorkbook({
    reader,
    guide: {
      title: say(PRODUCTION_TEMPLATE_WORDS.title({ month })),
      steps: [say(PRODUCTION_TEMPLATE_WORDS.stepFill), say(PRODUCTION_TEMPLATE_WORDS.stepFigures), say(PRODUCTION_TEMPLATE_WORDS.stepUpload)],
      columns: [
        { name: TEMPLATE_HEADER_V1[0], required: true, holds: say(PRODUCTION_TEMPLATE_WORDS.agentCode), example: '00088213' },
        { name: TEMPLATE_HEADER_V1[1], required: false, holds: say(PRODUCTION_TEMPLATE_WORDS.agentName), example: 'Rina Wijaya' },
        ...valueColumns.map(({ metric, cadence }, i) => ({
          name: TEMPLATE_HEADER_V1[2 + i],
          required: false,
          holds: `${say(METRIC_WORDS[metric])} ${say(cadence === 'monthly' ? PRODUCTION_TEMPLATE_WORDS.thisMonth : PRODUCTION_TEMPLATE_WORDS.yearToDate)}`,
          example: example(metric),
        })),
      ],
      rules: [
        say(PRODUCTION_TEMPLATE_WORDS.ruleCadence),
        say(PRODUCTION_TEMPLATE_WORDS.ruleNumbers),
        say(PRODUCTION_TEMPLATE_WORDS.ruleUnchanged),
        say(PRODUCTION_TEMPLATE_WORDS.rulePartial),
      ],
    },
    data: {
      header: TEMPLATE_HEADER_V1,
      rows: rows.map((r) => [r.agentCode, r.name.replace(/\s*[\r\n\t]+\s*/g, ' ').trim()]),
      widths: [14, 28, ...Array<number>(TEMPLATE_HEADER_V1.length - 2).fill(18)],
      textColumns: [0],
      fillRows: rows.length,
    },
  });
}
