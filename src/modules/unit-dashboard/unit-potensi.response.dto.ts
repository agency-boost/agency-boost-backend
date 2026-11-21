import { ApiProperty } from '@nestjs/swagger';
import { UNIT_DASHBOARD, type UnitView } from '@/domain/constants';
import { UnitInformalDto, UnitScopesDto } from './unit-dashboard.response.dto';
import type { UnitInformal } from './unit-dashboard.service';
import type {
  PotensiAaCell, PotensiKandidat, PotensiPerson, PotensiRekrutCell, PotensiRung, PotensiTotals, PotensiUnit,
  UnitPotensiPersonView, UnitPotensiView,
} from './unit-potensi.service';

/** Declared for OpenAPI. The wire shapes live on `UnitPotensiService`'s view types (P19.1-T6, UI-155). */

class PotensiRungDto implements PotensiRung {
  @ApiProperty({ example: 'AAB', description: 'The rung’s stable code.' }) code!: string;
  @ApiProperty({ example: 'AAB', description: 'As the company’s ladder names it (BP and SBP at Manulife).' }) label!: string;
}

class PotensiAaCellDto implements PotensiAaCell {
  @ApiProperty({ example: 2, description: '*n potensi*: sales leads switched on for the month and still open at its end.' })
  potensi!: number;
  @ApiProperty({
    description: '*Active Agent* in the month (`MONTHLY_ACTIVE_AGENT`, ADR-0267 §2): the uploaded production shows APE above '
      + '0 or a policy that month — the green ✓. Never a lead.',
  })
  aa!: boolean;
  @ApiProperty({ example: 2, description: 'Sales leads switched on for the month, whatever became of them.' })
  switched!: number;
}

class PotensiRekrutCellDto implements PotensiRekrutCell {
  @ApiProperty({ example: 1, description: '*n potensi*: recruitment leads switched on and still open at the month’s end.' })
  potensi!: number;
  @ApiProperty({
    example: 1,
    description: 'The green number (`RECRUITS_JOINED`, ADR-0267 §3): the new hires they registered who joined in the month.',
  })
  rekrut!: number;
  @ApiProperty({ example: 2, description: 'Recruitment leads switched on for the month, whatever became of them.' })
  switched!: number;
}

class PotensiPersonDto implements PotensiPerson {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Rina Wijaya' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'A signed link to their photo; `null` draws initials.' })
  photoUrl!: string | null;
  @ApiProperty({ type: PotensiRungDto }) rung!: PotensiRungDto;
  @ApiProperty({ description: 'The card’s leader: its first row, with the role tag before the name.' }) isLeader!: boolean;
  @ApiProperty() isReader!: boolean;
  @ApiProperty({
    description: 'Their sheet answers you: `lead:read` reaches them — yourself, or somebody you coach (§3.7). The row opens it.',
  })
  opens!: boolean;
  @ApiProperty({ type: PotensiAaCellDto }) aa!: PotensiAaCellDto;
  @ApiProperty({ type: PotensiRekrutCellDto }) rekrut!: PotensiRekrutCellDto;
}

class PotensiAaTotalsDto {
  @ApiProperty({
    description: 'The header’s *n potensi*: **the people** with a sales potensi — who can become Active Agent — never the sum.',
  }) potensi!: number;
  @ApiProperty({ description: 'The rows who are Active Agent in the month: the ✓ counted.' }) aa!: number;
  @ApiProperty({ description: 'The rows with a sales lead switched on for the month: an earlier month’s *y*.' })
  switchedPeople!: number;
  @ApiProperty({ description: 'Of those, the ones who are AA: an earlier month’s *x*.' }) switchedPeopleAa!: number;
}

class PotensiRekrutTotalsDto {
  @ApiProperty({ description: 'The rows’ *n potensi* summed: the header’s *potensi m*.' }) potensi!: number;
  @ApiProperty({ description: 'The rows’ green numbers summed: the header’s *n rekrut*.' }) rekrut!: number;
  @ApiProperty({ description: 'The rows with a recruitment lead switched on for the month: an earlier month’s *y*.' })
  switchedPeople!: number;
  @ApiProperty({ description: 'Of those, the ones with a rekrut in the month: an earlier month’s *x*.' })
  switchedPeopleRekrut!: number;
}

class PotensiTotalsDto implements PotensiTotals {
  @ApiProperty({ type: PotensiAaTotalsDto }) aa!: PotensiAaTotalsDto;
  @ApiProperty({ type: PotensiRekrutTotalsDto }) rekrut!: PotensiRekrutTotalsDto;
}

class PotensiLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Sari Puspita' }) name!: string;
  @ApiProperty({ type: PotensiRungDto }) rung!: PotensiRungDto;
}

class PotensiUnitDto implements PotensiUnit {
  @ApiProperty({
    enum: ['unit', 'direct', 'unled'],
    description: '`direct`: the head and their direct reports who lead nobody and are no AB (*Unit Anda*), **first** (ADR-0229 '
      + '§4; an AAB with no team sits there, ADR-0271 §2); `unit`: a unit below the head (*Unit Sari Puspita*), in the roster’s order; `unled`: *Belum punya leader*, '
      + 'last — in the owner’s or an administrator’s own *Semua downline*, the people with no leader there who lead nobody.',
  })
  kind!: 'unit' | 'direct' | 'unled';
  @ApiProperty({ type: PotensiLeaderDto, nullable: true, description: 'The card’s first row; `null` for `unled`.' })
  leader!: PotensiLeaderDto | null;
  @ApiProperty({ type: [PotensiPersonDto], description: 'The leader first, then the card’s people in the roster’s order.' })
  people!: PotensiPersonDto[];
  @ApiProperty({ type: PotensiTotalsDto }) totals!: PotensiTotalsDto;
}

class PotensiHeadDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isReader!: boolean;
}

class PotensiTilesPotensiDto {
  @ApiProperty({ example: 2, description: '*potensi n* under *Active Agent*: the people who can become Active Agent — the headers summed.' })
  aa!: number;
  @ApiProperty({ example: 3, description: '*potensi m* under *Rekrut*: the kandidat switched on and still open, summed.' })
  rekrut!: number;
}

class PotensiTilesDto {
  @ApiProperty({ example: 3, description: 'The people of the unit who are Active Agent in the month, from the upload.' }) aa!: number;
  @ApiProperty({ example: 3, description: 'The new hires who joined in the month, credited to the people of the unit.' }) rekrut!: number;
  @ApiProperty({
    type: PotensiTilesPotensiDto,
    description: 'ADR-0271 §8: *Active Agent · potensi n* counts people; *Rekrut n · potensi m* sums the kandidat.',
  })
  potensi!: PotensiTilesPotensiDto;
}

/** `GET /unit/dashboard/potensi` (P19.1-T6, UI-155). */
export class UnitPotensiDto implements UnitPotensiView {
  @ApiProperty({ example: '2026-11', description: 'The month read, on the agency’s calendar.' }) month!: string;
  @ApiProperty({ example: '2026-11', description: 'The agency’s current month: an earlier `month` is drawn as one row per unit.' })
  currentMonth!: string;
  @ApiProperty({ example: '2026-11-04' }) today!: string;
  @ApiProperty({ type: PotensiHeadDto }) head!: PotensiHeadDto;
  @ApiProperty({ type: PotensiTilesDto }) tiles!: PotensiTilesDto;
  @ApiProperty({ type: [PotensiUnitDto], description: 'The head’s own card first, then one card per unit below the head (ADR-0229 §4).' })
  units!: PotensiUnitDto[];
  @ApiProperty({ enum: UNIT_DASHBOARD.VIEWS, description: 'The view this answer is over, as `GET /unit/dashboard`’s.' })
  scope!: UnitView;
  @ApiProperty({ type: UnitScopesDto }) scopes!: UnitScopesDto;
  @ApiProperty({ type: UnitInformalDto, nullable: true, description: 'In `informal` only, as `GET /unit/dashboard`’s.' })
  informal!: UnitInformal | null;
}

class PotensiSalesLeadDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Ibu Kartika Dewanti', description: 'The client’s name (Q-2: a leader sees it).' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The stage’s code; the screen names it in the agency’s words.' })
  statusCode!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-04' }) nextActionDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextActionNote!: string | null;
}

class PotensiKandidatDto implements PotensiKandidat {
  @ApiProperty() leadId!: string;
  @ApiProperty({ example: 'Sdri. Maya Lestari' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) statusCode!: string | null;
  @ApiProperty({ enum: ['potensi', 'rekrut'] }) state!: 'potensi' | 'rekrut';
  @ApiProperty({ type: String, nullable: true, example: '2026-11-18', description: 'The agency day they became rekrut.' })
  rekrutOn!: string | null;
  @ApiProperty({
    type: String, nullable: true,
    description: 'The membership they became, linked through *Tambahkan ke unit ›* — *New Hires ›* opens it. `null` until then.',
  })
  newHireMembershipId!: string | null;
}

class PotensiSheetPersonDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: PotensiRungDto }) rung!: PotensiRungDto;
  @ApiProperty({ type: String, nullable: true, description: 'Their WhatsApp number while their membership is active.' })
  phone!: string | null;
  @ApiProperty() isReader!: boolean;
}

class PotensiSheetUnitDto {
  @ApiProperty({ example: 'Sari Puspita' }) name!: string;
  @ApiProperty({ type: PotensiRungDto }) rung!: PotensiRungDto;
}

/** `GET /unit/dashboard/potensi/:membershipId` (P19.1-T6 AC-6, AC-7). */
export class UnitPotensiPersonDto implements UnitPotensiPersonView {
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ example: '2026-11' }) currentMonth!: string;
  @ApiProperty({ type: PotensiSheetPersonDto }) person!: PotensiSheetPersonDto;
  @ApiProperty({ type: PotensiSheetUnitDto, nullable: true, description: 'The unit line: their own unit, or their leader’s.' })
  unit!: PotensiSheetUnitDto | null;
  @ApiProperty({ type: [PotensiSalesLeadDto], description: 'Sales leads switched on and still open, nearest next action first.' })
  sales!: PotensiSalesLeadDto[];
  @ApiProperty({ type: [PotensiKandidatDto], description: 'Kandidat switched on and still open, then those who became rekrut.' })
  kandidat!: PotensiKandidatDto[];
}
