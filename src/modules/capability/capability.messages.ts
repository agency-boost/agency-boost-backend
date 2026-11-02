import { formatNumber } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: grouped the Indonesian way once it reaches a thousand (*1.250*). */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/**
 * **Where a capability problem sits**, as each language names it: *Stage 2*, *Grid 1, item 3* — *Tahap 2*, *Grid 1,
 * item 3*. *Milestone*, *grid* and *item* stay as the Capability Mapping screen names them; a stage is a *tahap*.
 */
export type CapabilityPlace =
  | { part: 'milestone' | 'stage' | 'grid'; n: number }
  | { part: 'item'; grid: number; n: number };

const PLACE_NAMES = {
  en: { milestone: 'Milestone', stage: 'Stage', grid: 'Grid' },
  id: { milestone: 'Milestone', stage: 'Tahap', grid: 'Grid' },
} as const;

function placeIn(language: 'en' | 'id', place: CapabilityPlace): string {
  return place.part === 'item'
    ? `${PLACE_NAMES[language].grid} ${place.grid}, item ${place.n}`
    : `${PLACE_NAMES[language][place.part]} ${place.n}`;
}

/** A list part the reorder names: a stage is a *tahap*; a milestone and a grid keep the screen's words. */
const PART_ID = { stage: 'tahap', milestone: 'milestone', grid: 'grid' } as const;

/**
 * **The capability catalog's refusals, in both languages** (P18.98-T5 AC-2, AC-3): what makes a `capability_ladder`
 * payload produce a broken office (`capabilityLadderProblems`, read by a template's publish and by provisioning),
 * and what the office's own edits are refused for. A field is named as the API names it (`stageOrder`); a stage is a
 * *tahap*, a tick a *centang*, and *milestone*, *grid* and *item* stay as the screen writes them.
 */
export const CAPABILITY_REFUSALS = refusals('modules/capability', {
  VALIDATION_FAILED: {
    notAList: ({ key }: { key: 'stages' | 'milestones' | 'grids' }) => ({
      en: `${key} must be a list.`,
      id: `${key} harus berupa daftar.`,
    }),
    noStages: {
      en: 'A capability catalog with no stages is a ladder nobody can be on.',
      id: 'Katalog capability tanpa tahap adalah ladder yang tidak dapat ditempati siapa pun.',
    },
    noMilestones: {
      en: 'A capability catalog with no milestones can never place anybody on a stage.',
      id: 'Katalog capability tanpa milestone tidak akan pernah dapat menempatkan siapa pun di suatu tahap.',
    },
    noCode: ({ place }: { place: CapabilityPlace }) => ({
      en: `${placeIn('en', place)} has no code. Every item carries one, so a rename never moves a tick.`,
      id: `${placeIn('id', place)} tidak memiliki kode. Setiap item memilikinya, sehingga mengganti nama tidak pernah `
        + 'memindahkan centang.',
    }),
    codeTwice: ({ code }: { code: string }) => ({
      en: `The code ${code} is used twice. A tick names a code, so two would be one tick.`,
      id: `Kode ${code} dipakai dua kali. Centang merujuk ke satu kode, jadi dua kode yang sama akan menjadi satu centang.`,
    }),
    noLabel: ({ place }: { place: CapabilityPlace }) => ({
      en: `${placeIn('en', place)} has no label.`,
      id: `${placeIn('id', place)} tidak memiliki label.`,
    }),
    stageOrderMin: ({ stage }: { stage: number }) => ({
      en: `Stage ${stage} needs a stageOrder of 1 or more — it is how senior the stage is.`,
      id: `Tahap ${stage} memerlukan stageOrder 1 atau lebih — itulah tingkat senioritas tahap tersebut.`,
    }),
    stageOrderShared: ({ order }: { order: number }) => ({
      en: `Two stages share stageOrder ${order}, so which one somebody reached is undecidable.`,
      id: `Dua tahap memakai stageOrder ${order} yang sama, jadi tidak dapat ditentukan tahap mana yang dicapai seseorang.`,
    }),
    stageNoMilestone: ({ stage }: { stage: number }) => ({
      en: `Stage ${stage} requires no milestone, so everybody is already on it.`,
      id: `Tahap ${stage} tidak mensyaratkan milestone apa pun, jadi semua orang sudah berada di tahap itu.`,
    }),
    stageUnknownMilestone: ({ stage, code }: { stage: number; code: string }) => ({
      en: `Stage ${stage} requires ${code}, which no milestone in this catalog is — nobody could ever reach it.`,
      id: `Tahap ${stage} mensyaratkan ${code}, yang bukan milestone mana pun di katalog ini — tidak ada yang dapat `
        + 'mencapainya.',
    }),
    gridNoItems: ({ grid }: { grid: number }) => ({
      en: `Grid ${grid} has no items, so there is nothing to assess in it.`,
      id: `Grid ${grid} tidak memiliki item, jadi tidak ada yang dapat dinilai di dalamnya.`,
    }),

    /* The office's own edits (`CapabilityService`). */
    labelEmpty: {
      en: 'A label cannot be empty.',
      id: 'Label tidak boleh kosong.',
    },
    milestoneRequired: ({ stages }: { stages: readonly string[] }) => ({
      en: `${stages.join(', ')} require this milestone, so archiving it would make those stages unreachable. `
        + 'Take it out of them first.',
      id: `${stages.join(', ')} mensyaratkan milestone ini, jadi mengarsipkannya akan membuat tahap itu tidak dapat `
        + 'dicapai. Keluarkan milestone ini dari tahap itu terlebih dahulu.',
    }),
    itemNeedsCode: {
      en: 'An item needs a code.',
      id: 'Item memerlukan kode.',
    },
    itemNeedsLabel: {
      en: 'An item needs a label.',
      id: 'Item memerlukan label.',
    },
    codeUsed: ({ code }: { code: string }) => ({
      en: `${code} is already used in this catalog. A code is never reused — a tick names one, `
        + 'so the same code twice would be the same tick.',
      id: `${code} sudah dipakai di katalog ini. Kode tidak pernah dipakai ulang — centang merujuk ke satu kode, `
        + 'jadi kode yang sama dua kali akan menjadi centang yang sama.',
    }),
    sendEvery: ({ part, count }: { part: 'stage' | 'milestone' | 'grid'; count: number }) => ({
      en: `Send every ${part} once each — ${count} of them.`,
      id: `Kirim setiap ${PART_ID[part]} masing-masing sekali — semuanya ${idCount(count)}.`,
    }),
  },
});
