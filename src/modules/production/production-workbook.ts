import { formatMonth, formatNumber } from '@/common/format/format';
import type { Reader } from '@/common/i18n/reader';
import { render } from '@/common/i18n/sentence';
import { writeWorkbook } from '@/common/spreadsheet/write-xlsx';
import type { AdvancedAnalyticsConfig, UploadField } from '@/modules/config/analytics-config';
import { fileColumns, labelIn, templateHeader } from './production-template';
import { PRODUCTION_TEMPLATE_WORDS } from './production-template.messages';

/*
 * **The template as an Excel workbook** (ADR-0184), apart from `production-template.ts`, which is the file's contract:
 * the header and the rows are that file's; only the guide beside them is written for a reader. *Since P19.5-T2*
 * (ADR-0214 §5) its columns are the KPM's template's, and the *Petunjuk* lists each one.
 */

/** A value each unit's column would take, as a reader of either language types it. */
const UNIT_EXAMPLE: Record<UploadField['unit'], number> = { rp_million: 1.5, percent: 85, count: 2 };

/**
 * **What one column holds, for the guide** (P19.5-T2 AC-1): its unit, whether it is required and from which month, whom
 * it is for (`rows`), its start month, and its tip — in the reader's language.
 */
function holds(field: UploadField, ytd: boolean, month: string, reader: Reader): string {
  const say = (message: Parameters<typeof render>[0]) => render(message, reader);
  const parts = [
    say(PRODUCTION_TEMPLATE_WORDS.unitOf({ unit: field.unit })),
    ytd ? say(PRODUCTION_TEMPLATE_WORDS.yearToDate) : say(PRODUCTION_TEMPLATE_WORDS.thisMonth),
    field.required
      ? say(PRODUCTION_TEMPLATE_WORDS.requiredFrom({ month: formatMonth(field.effectiveFrom, reader.language) }))
      : say(PRODUCTION_TEMPLATE_WORDS.optional),
    say(PRODUCTION_TEMPLATE_WORDS.startsIn({ month: formatMonth(field.effectiveFrom, reader.language) })),
    ...(field.effectiveFrom > month ? [say(PRODUCTION_TEMPLATE_WORDS.notYetInForce)] : []),
    ...(field.rows === 'leaders' ? [say(PRODUCTION_TEMPLATE_WORDS.leaderRowsOnly)] : []),
  ];
  const tip = labelIn({ label: field.tip }, reader.language);
  return [...parts, ...(tip ? [tip] : [])].join(' ');
}

/**
 * **The month's template as a workbook** (ADR-0184): the *Petunjuk* (*Guide*) sheet in the reader's language — a row
 * per column of the KPM's template — and the **Data** sheet: the same header as the CSV (`templateHeader`) and the same
 * rows, one per active agent with the code and the name and empty cells.
 *
 * **The code column is text**, so a code keeps its leading zeros however the person's spreadsheet is set up — the
 * defect ADR-0052 forgives in a CSV is not made in the first place. **A name is a string**, never a formula, so it needs
 * no leading apostrophe here: the CSV's `csvName` guards a format that is read as formulas, and a workbook's cell is
 * whatever type it is written as. It is still made one line.
 */
export function templateWorkbook(
  config: AdvancedAnalyticsConfig,
  rows: readonly { agentCode: string; name: string }[],
  month: string,
  reader: Reader,
): Promise<Buffer> {
  const say = (message: Parameters<typeof render>[0]) => render(message, reader);
  const header = templateHeader(config, reader.language);
  const columns = fileColumns(config);

  return writeWorkbook({
    reader,
    guide: {
      title: say(PRODUCTION_TEMPLATE_WORDS.title({ month })),
      steps: [say(PRODUCTION_TEMPLATE_WORDS.stepFill), say(PRODUCTION_TEMPLATE_WORDS.stepFigures), say(PRODUCTION_TEMPLATE_WORDS.stepUpload)],
      columns: [
        { name: header[0], required: true, holds: say(PRODUCTION_TEMPLATE_WORDS.agentCode), example: '00088213' },
        { name: header[1], required: false, holds: say(PRODUCTION_TEMPLATE_WORDS.agentName), example: 'Rina Wijaya' },
        ...columns.map(({ field, ytd }, i) => ({
          name: header[2 + i],
          required: field.required && !ytd,
          holds: holds(field, ytd, month, reader),
          example: formatNumber(UNIT_EXAMPLE[field.unit], undefined, reader.language),
        })),
      ],
      rules: [
        say(PRODUCTION_TEMPLATE_WORDS.ruleCalculatedYtd),
        say(PRODUCTION_TEMPLATE_WORDS.ruleNumbers),
        say(PRODUCTION_TEMPLATE_WORDS.ruleUnchanged),
        say(PRODUCTION_TEMPLATE_WORDS.ruleLeaderOnly),
        say(PRODUCTION_TEMPLATE_WORDS.rulePartial),
      ],
    },
    data: {
      header,
      rows: rows.map((r) => [r.agentCode, r.name.replace(/\s*[\r\n\t]+\s*/g, ' ').trim()]),
      widths: [14, 28, ...Array<number>(header.length - 2).fill(18)],
      textColumns: [0],
      fillRows: rows.length,
    },
  });
}
