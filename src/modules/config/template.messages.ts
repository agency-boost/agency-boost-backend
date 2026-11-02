import { readerIn } from '@/common/i18n/reader';
import { messages, refusals, render, type Sentence } from '@/common/i18n/sentence';

/**
 * **A section of a template, as a refusal names it before its problems** — *Activity binding: …*. The settings' own
 * names stay English in both languages (§A.1, §A.3: the nav and the Company template's tabs); the binding, which is
 * neither, is a *pengaitan aktivitas*.
 */
export const TEMPLATE_SECTIONS = {
  activityTypes: { en: 'Activity types', id: 'Activity types' },
  activityBinding: { en: 'Activity binding', id: 'Pengaitan aktivitas' },
  leadStatuses: { en: 'Lead statuses', id: 'Lead statuses' },
  ratioBenchmarks: { en: 'Ratio benchmarks', id: 'Ratio benchmarks' },
  training: { en: 'Training', id: 'Training' },
  activationChecklist: { en: 'Activation checklist', id: 'Activation checklist' },
  events: { en: 'Events', id: 'Events' },
  capabilityMapping: { en: 'Capability mapping', id: 'Capability mapping' },
} as const;
export type TemplateSection = keyof typeof TEMPLATE_SECTIONS;

/**
 * **What a broken office would have been made from**, as its refusal begins: a template by its name (as typed), the
 * AgencyBoost defaults, an office's published settings (*Save as template*), or — where none of those is known — the
 * source.
 */
export type BrokenSource =
  | { kind: 'template'; name: string }
  | { kind: 'defaults' }
  | { kind: 'office'; code: string }
  | { kind: 'source' };

function sourceIn(language: 'en' | 'id', source: BrokenSource): string {
  switch (source.kind) {
    case 'template': return source.name;
    case 'defaults': return language === 'en' ? 'The AgencyBoost defaults' : 'Pengaturan default AgencyBoost';
    case 'office': return language === 'en'
      ? `KPM ${source.code}’s published settings`
      : `Pengaturan KPM ${source.code} yang diterbitkan`;
    default: return language === 'en' ? 'The source' : 'Sumber ini';
  }
}

/** A list of codes, as every sentence here writes one. */
const list = (codes: readonly string[]) => codes.join(', ');

/**
 * **The Super Admin's templates, and the offices made from them, refused in both languages** (P18.98-T5 AC-2, AC-3):
 * a kind's publish, the named templates, copying one across companies, and provisioning's whole-source check. A
 * template is a *template*, its kinds' settings keep their names (`TEMPLATE_SECTIONS`), and a template's name, as the
 * Super Admin typed it, stays as typed.
 */
export const TEMPLATE_REFUSALS = refusals('modules/config/templates', {
  VALIDATION_FAILED: {
    /* A kind's publish (`TemplateService`). */
    nothingToPublish: {
      en: 'There is nothing to publish. Change something first — the published version is '
        + 'immutable, because offices record which one they were built from.',
      id: 'Tidak ada yang dapat diterbitkan. Ubah sesuatu terlebih dahulu — versi yang diterbitkan tidak dapat diubah, '
        + 'karena setiap KPM mencatat versi mana yang menjadi dasarnya.',
    },
    editArchived: ({ name }: { name: string }) => ({
      en: `${name} is archived, so it is kept as it is. Edit an active template instead.`,
      id: `${name} sudah diarsipkan, jadi disimpan apa adanya. Ubah template yang aktif saja.`,
    }),
    noRatios: {
      en: 'A ratio set with no ratios gives every new office nothing to measure.',
      id: 'Kumpulan ratio tanpa ratio membuat setiap KPM baru tidak memiliki apa pun untuk diukur.',
    },
    ratioCodesUndeclared: ({ codes, version }: { codes: readonly string[]; version: number | null }) => ({
      en: `${list(codes)} is named by a ratio and declared by no activity type in this `
        + `template’s published taxonomy${version !== null ? ` (version ${version})` : ''}. `
        + 'Publish the taxonomy first, or point the ratio at a code it has.',
      id: `${list(codes)} disebut oleh ratio, tetapi tidak dideklarasikan oleh jenis aktivitas mana pun di taksonomi `
        + `template ini yang sudah diterbitkan${version !== null ? ` (versi ${version})` : ''}. Terbitkan taksonominya `
        + 'terlebih dahulu, atau arahkan ratio ke kode yang ada.',
    }),
    noDenominator: ({ code }: { code: string }) => ({
      en: `${code} has nothing in its denominator. That is a division by zero dressed `
        + 'up as configuration, and it renders as ∞ on every agent’s screen.',
      id: `${code} tidak memiliki apa pun di penyebutnya. Itu pembagian dengan nol yang menyamar sebagai konfigurasi, `
        + 'dan akan tampil sebagai ∞ di layar setiap agent.',
    }),
    taxonomyEmpty: {
      en: 'A taxonomy with no categories or no types would give every new office an empty '
        + 'Log Activity screen.',
      id: 'Taksonomi tanpa kategori atau tanpa jenis aktivitas akan memberi setiap KPM baru layar Log Activity yang '
        + 'kosong.',
    },
    pipelineNoStages: ({ pipeline }: { pipeline: string }) => ({
      en: `The ${pipeline} pipeline has no stages.`,
      id: `Pipeline ${pipeline} tidak memiliki tahap.`,
    }),
    pipelineOneTerminal: ({ pipeline }: { pipeline: string }) => ({
      en: `The ${pipeline} pipeline needs exactly one stage that closes it. It is what `
        + 'gates marking a lead successful.',
      id: `Pipeline ${pipeline} memerlukan tepat satu tahap penutup. Tahap itulah syarat untuk menandai lead berhasil.`,
    }),
    /** A section's problems, each or all at once, after its name: *Activity binding: …*. */
    inSection: ({ section, inner }: { section: TemplateSection; inner: Sentence }) => ({
      en: (figures) => `${TEMPLATE_SECTIONS[section].en}: ${render(inner, { language: 'en', figures })}`,
      id: `${TEMPLATE_SECTIONS[section].id}: ${render(inner, readerIn('id'))}`,
    }),

    /* A lead pipeline payload (`leadPipelineProblems`): publishing and provisioning alike. */
    flaggedBoth: ({ codes }: { codes: readonly string[] }) => ({
      en: `${list(codes)} is flagged as both the stage that closes its `
        + 'pipeline and a stage still expected to close. A lead can only be one.',
      id: `${list(codes)} ditandai sebagai tahap penutup pipeline sekaligus tahap yang masih diperkirakan closing. `
        + 'Lead hanya bisa salah satunya.',
    }),
    terminalCount: ({ pipeline, count }: { pipeline: string; count: number }) => ({
      en: `The ${pipeline} pipeline has ${count} terminal stages. It needs exactly one: it is `
        + 'what gates marking a lead successful.',
      id: `Pipeline ${pipeline} memiliki ${count} tahap penutup. Pipeline memerlukan tepat satu: tahap itulah syarat `
        + 'untuk menandai lead berhasil.',
    }),

    /* An office's source, checked whole before it is made (`ProvisioningService`). */
    chooseTemplate: {
      en: 'Choose the template the office starts from.',
      id: 'Pilih template yang menjadi awal KPM ini.',
    },
    startFromArchived: ({ name }: { name: string }) => ({
      en: `${name} is archived and is not offered. Start the office from an active template.`,
      id: `${name} sudah diarsipkan dan tidak ditawarkan. Mulai KPM dari template yang aktif.`,
    }),
    tileLabelled: ({ code, labels }: { code: string; labels: readonly string[] }) => ({
      en: `the summary tile ${code} is labelled `
        + `${labels.join(' and ')}. One tile has one label.`,
      id: `kotak ringkasan ${code} berlabel ${labels.join(' dan ')}. Satu kotak memiliki satu label.`,
    }),
    tileCodeTaken: ({ code }: { code: string }) => ({
      en: `the summary tile ${code} has the code of a section `
        + 'outside it. One code is one tile.',
      id: `kotak ringkasan ${code} memakai kode bagian di luarnya. Satu kode untuk satu kotak.`,
    }),
    ratioNamesMissing: ({ code, missing }: { code: string; missing: readonly string[] }) => ({
      en: `${code} names ${list(missing)}, which the activity types `
        + 'it would be given do not contain.',
      id: `${code} menyebut ${list(missing)}, yang tidak ada di jenis aktivitas yang akan diberikan.`,
    }),
    checklistLinks: ({ codes }: { codes: readonly string[] }) => ({
      en: `it links to training modules the office would not be given: `
        + `${list(codes)}.`,
      id: `checklist ini tertaut ke modul training yang tidak akan diberikan ke KPM: ${list(codes)}.`,
    }),
    brokenOffice: ({ source, problems }: { source: BrokenSource; problems: Sentence }) => ({
      en: (figures) => `${sourceIn('en', source)} would produce a broken office, so nothing was created. `
        + `${render(problems, { language: 'en', figures })}`,
      id: `${sourceIn('id', source)} akan menghasilkan KPM yang rusak, jadi tidak ada yang dibuat. `
        + `${render(problems, readerIn('id'))}`,
    }),

    /* The named templates (`NamedTemplateService`, `TemplateCopyService`). */
    templateNeedsName: {
      en: 'A template needs a name.',
      id: 'Template memerlukan nama.',
    },
    archivedCannotBeDefault: {
      en: 'An archived template cannot be the default. Use an active one.',
      id: 'Template yang diarsipkan tidak dapat menjadi default. Gunakan template yang aktif.',
    },
    alreadyThisCompanys: {
      en: 'That template is already this company’s. Use New template and copy it instead.',
      id: 'Template itu sudah milik perusahaan ini. Gunakan Template baru dan salin template itu saja.',
    },
    /** The DTO's own sentence (`field`), its values as the API takes them. */
    fromShape: {
      en: 'from must be "empty", "defaults", or { templateId } naming one of the company’s templates',
      id: 'from harus "empty", "defaults", atau { templateId } yang menyebut salah satu template perusahaan',
    },
  },
  VERSION_CONFLICT: {
    defaultMoved: {
      en: 'This company’s default template changed while this was being saved, and nothing was changed. '
        + 'Reload the templates and try again.',
      id: 'Template default perusahaan ini berubah saat perubahan ini sedang disimpan, dan tidak ada yang diubah. '
        + 'Muat ulang daftar template, lalu coba lagi.',
    },
  },
  TEMPLATE_IS_DEFAULT: {
    cannotStopBeingDefault: ({ name }: { name: string }) => ({
      en: `${name} is this company’s default template, so it `
        + 'cannot stop being the default on its own. Make another template the default instead.',
      id: `${name} adalah template default perusahaan ini, jadi tidak dapat berhenti menjadi default dengan sendirinya. `
        + 'Jadikan template lain sebagai default saja.',
    }),
    cannotArchive: ({ name }: { name: string }) => ({
      en: `${name} is this company’s default template, so it `
        + 'cannot be archived. Make another template the default first, then archive this one.',
      id: `${name} adalah template default perusahaan ini, jadi tidak dapat diarsipkan. Jadikan template lain sebagai `
        + 'default terlebih dahulu, lalu arsipkan template ini.',
    }),
  },
  TEMPLATE_NAME_TAKEN: {
    taken: ({ name }: { name: string }) => ({
      en: `This company already has a template called ${name}. Choose another name.`,
      id: `Perusahaan ini sudah memiliki template bernama ${name}. Pilih nama lain.`,
    }),
  },
  TEMPLATE_RUNG_UNKNOWN: {
    notOnTheLadder: ({ codes }: { codes: readonly string[] }) => ({
      en: `This company’s role ladder has no ${list(codes)}, and the settings being copied show `
        + `ratios or activity sections to ${codes.length === 1 ? 'that role' : 'those roles'}. Add `
        + `${codes.length === 1 ? 'it' : 'them'} to the company’s ladder first, or copy other settings.`,
      id: `Susunan jenjang perusahaan ini tidak memiliki ${list(codes)}, padahal pengaturan yang disalin menampilkan `
        + 'ratio atau bagian aktivitas ke peran itu. Tambahkan peran itu ke susunan jenjang perusahaan terlebih dahulu, '
        + 'atau salin pengaturan lain.',
    }),
  },
  ASSET_NOT_CONFIRMED: {
    neverUploaded: ({ label, moduleCode }: { label: string; moduleCode: string }) => ({
      en: `The file “${label}” in training module ${moduleCode} never finished `
        + 'uploading, so it cannot be copied and nothing was. Have it uploaded again, or removed, '
        + 'and try again.',
      id: `File “${label}” di modul training ${moduleCode} tidak pernah selesai diunggah, jadi tidak dapat disalin dan `
        + 'tidak ada yang disalin. Minta file itu diunggah ulang, atau dihapus, lalu coba lagi.',
    }),
  },
});

/** `OLD_VISIT, which is not an active activity type` — or, for several, `…, which are not active activity types`. */
const notActiveTypes = (codes: readonly string[]) => (codes.length === 1
  ? `${codes[0]}, which is not an active activity type`
  : `${list(codes)}, which are not active activity types`);

/** The same, in Indonesian: one form for one and for many (§B.0). */
const notActiveTypesId = (codes: readonly string[]) => `${list(codes)}, yang bukan jenis aktivitas aktif`;

/** A ratio's sides that count only what was archived, in each language. */
const SIDES = {
  en: { both: 'its numerator and its denominator count', numerator: 'its numerator counts', denominator: 'its denominator counts' },
  id: { both: 'pembilang dan penyebutnya', numerator: 'pembilangnya', denominator: 'penyebutnya' },
} as const;

/**
 * **What *Save as template* left out of an office's settings, and why** (P18.98-T5 AC-4; the exit review of P13.2,
 * finding 2): one sentence each, naming the codes, written for the person who saved — in the answer, which the office
 * page shows, and in the audit row.
 */
export const TEMPLATE_MESSAGES = messages('modules/config/templates', {
  bindingLeftOut: ({ roles, gone }: { roles: readonly string[]; gone: readonly string[] }) => ({
    en: `The activity binding was left out: ${roles.join(', ')} `
      + `would count ${gone.length ? `only ${notActiveTypes(gone)}` : 'nothing'} in this office. Offices made from the template count the `
      + 'default binding.',
    id: `Pengaitan aktivitas tidak disertakan: ${roles.join(', ')} `
      + (gone.length
        ? `hanya akan menghitung ${notActiveTypesId(gone)} di KPM ini.`
        : 'tidak akan menghitung apa pun di KPM ini.')
      + ' KPM yang dibuat dari template ini menghitung pengaitan default.',
  }),
  bindingNoLonger: ({ gone }: { gone: readonly string[] }) => ({
    en: `The activity binding no longer counts ${notActiveTypes(gone)} in this office.`,
    id: `Pengaitan aktivitas tidak lagi menghitung ${notActiveTypesId(gone)} di KPM ini.`,
  }),
  ratioLeftOut: ({ code, side, gone }: { code: string; side: keyof typeof SIDES.en; gone: readonly string[] }) => ({
    en: `Ratio ${code} was left out: ${SIDES.en[side]} only ${notActiveTypes(gone)} in this office.`,
    id: `Ratio ${code} tidak disertakan: ${SIDES.id[side]} hanya menghitung ${notActiveTypesId(gone)} di KPM ini.`,
  }),
  ratioNoLonger: ({ code, gone }: { code: string; gone: readonly string[] }) => ({
    en: `Ratio ${code} no longer counts ${notActiveTypes(gone)} in this office.`,
    id: `Ratio ${code} tidak lagi menghitung ${notActiveTypesId(gone)} di KPM ini.`,
  }),
  checklistManual: ({ item, moduleCode }: { item: string; moduleCode: string }) => ({
    en: `Checklist item ${item} is kept as a manual item: the training module ${moduleCode} `
      + 'it linked to is not offered in this office.',
    id: `Item checklist ${item} dipertahankan sebagai item manual: modul training ${moduleCode} yang ditautkannya `
      + 'tidak ditawarkan di KPM ini.',
  }),
  stageLeftOut: ({ code, gone }: { code: string; gone: readonly string[] }) => ({
    en: `Stage ${code} was left out: every milestone it requires (${list(gone)}) is archived in `
      + 'this office, so an office made from the template would put everybody on it.',
    id: `Tahap ${code} tidak disertakan: setiap milestone yang disyaratkannya (${list(gone)}) sudah diarsipkan di KPM `
      + 'ini, jadi KPM yang dibuat dari template ini akan menempatkan semua orang di tahap itu.',
  }),
  stageNoLonger: ({ code, gone }: { code: string; gone: readonly string[] }) => ({
    en: `Stage ${code} no longer requires ${list(gone)}, ${gone.length === 1 ? 'which is' : 'which are'} archived in `
      + 'this office.',
    id: `Tahap ${code} tidak lagi mensyaratkan ${list(gone)}, yang sudah diarsipkan di KPM ini.`,
  }),
  gridLeftOut: ({ code }: { code: string }) => ({
    en: `Grid ${code} was left out: every item in it is archived in this office.`,
    id: `Grid ${code} tidak disertakan: setiap item di dalamnya sudah diarsipkan di KPM ini.`,
  }),
  ladderLeftOut: ({ missing }: { missing: 'stage' | 'milestone' }) => ({
    en: `The capability ladder was left out: it has no active ${missing} `
      + 'left, so it could place nobody. An office made from the template starts with AgencyBoost’s standard '
      + 'capability ladder instead.',
    id: `Ladder capability tidak disertakan: tidak ada lagi ${missing === 'stage' ? 'tahap' : 'milestone'} aktif, jadi `
      + 'ladder ini tidak dapat menempatkan siapa pun. KPM yang dibuat dari template ini akan dimulai dengan ladder '
      + 'capability standar AgencyBoost.',
  }),
});
