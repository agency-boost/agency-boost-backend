import { ApiProperty } from '@nestjs/swagger';
import { AUDIT_LOG } from '@/domain/constants';
import { AuditEntryResponseDto } from '@/modules/tenants/platform.response.dto';

/**
 * **One line of the audit page** (P19.2-T2 AC-6; `metrics-and-definitions.md` §B.32): the newest row of a run of
 * identical rows — the same actor, action and target, each within the window of the newest — with how many it stands
 * for. A row nothing repeats is a group of one.
 */
export class AuditGroupDto extends AuditEntryResponseDto {
  @ApiProperty({
    type: Number, minimum: 1, example: 28,
    description: 'How many rows this line stands for — the page’s *×28*. `1` for a row nothing repeated.',
  })
  count!: number;

  @ApiProperty({
    type: String, format: 'date-time',
    description: `The oldest row's time; \`createdAt\` is the newest's. At most ${AUDIT_LOG.GROUP_WINDOW_MINUTES} `
      + 'minutes apart, and equal for a group of one.',
  })
  oldestAt!: string;
}

/** Where the page stands: the cursor asked with, the one to ask with next, and whether there is more. */
export class AuditPageInfoDto {
  @ApiProperty({ type: String, nullable: true, description: 'The cursor this page was asked with; null for the first.' })
  cursor!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Ask with this for the next page (*Muat lagi*); null on the last.' })
  nextCursor!: string | null;

  @ApiProperty({ type: Number, example: AUDIT_LOG.PAGE_SIZE, description: 'The most groups a page holds.' })
  limit!: number;

  @ApiProperty({ type: Boolean })
  hasMore!: boolean;
}

/** One actor the *Pelaku* chip offers. */
export class AuditActorDto {
  @ApiProperty({ type: String })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Their name, or null if the account is gone.' })
  name!: string | null;
}

/** One action the *Tindakan* chip offers, in the reader's words (P19.4-T3 AC-11). */
export class AuditActionLabelDto {
  @ApiProperty({ type: String, example: 'company_template.draft_saved' })
  action!: string;

  @ApiProperty({ type: String, example: 'Draf template disimpan' })
  label!: string;
}

/** What the *Tindakan* and *Pelaku* chips offer: every action and actor within the reach, whatever the filters. */
export class AuditFacetsDto {
  @ApiProperty({ type: String, isArray: true, example: ['company.created', 'company_template.draft_saved'] })
  actions!: string[];

  @ApiProperty({
    type: () => AuditActionLabelDto, isArray: true,
    description: 'Each of `actions`, in the same order, with its label in the reader\'s words — what the chip shows.',
  })
  actionLabels!: AuditActionLabelDto[];

  @ApiProperty({
    type: () => AuditActorDto, isArray: true,
    description: 'The actors of a leader note’s rows are left out (ADR-0073).',
  })
  actors!: AuditActorDto[];
}

/** **`GET /admin/audit`'s page** (§B.32): at most fifty groups, newest first, and the cursor for the next. */
export class AuditPageDto {
  @ApiProperty({ type: () => AuditGroupDto, isArray: true })
  items!: AuditGroupDto[];

  @ApiProperty({ type: () => AuditPageInfoDto })
  page!: AuditPageInfoDto;

  @ApiProperty({
    type: () => AuditFacetsDto, nullable: true,
    description: 'On the first page only (no `cursor`); null on every later one.',
  })
  facets!: AuditFacetsDto | null;
}
