import { refusals } from '@/common/i18n/sentence';

/** A list of codes, as every sentence here writes one. */
const list = (codes: readonly string[]) => codes.join(', ');

/**
 * **A template's training material and its push to the KPMs made from it, refused in both languages** (ADR-0208): the
 * material's module that is not in the template, the push asked for nothing, a built-in template that reaches nobody,
 * a section a KPM could not take, and a KPM's own changes that would be replaced without the second confirmation.
 */
export const TEMPLATE_PUSH_REFUSALS = refusals('modules/config/template-push', {
  VALIDATION_FAILED: {
    /* The material (`TemplateMaterialService`). */
    moduleNotInTemplate: ({ code }: { code: string }) => ({
      en: `The training section of this template has no module ${code}. Add the module first, then its material.`,
      id: `Bagian training template ini tidak memiliki modul ${code}. Tambahkan modulnya terlebih dahulu, lalu materinya.`,
    }),
    notThisCompanysFile: ({ label }: { label: string }) => ({
      en: `The file “${label}” is not one of this company’s uploads, so it cannot be material here. Upload it again.`,
      id: `File “${label}” bukan unggahan perusahaan ini, jadi tidak dapat menjadi materi di sini. Unggah ulang file itu.`,
    }),
    /* The push (`TemplatePushService`). */
    nothingToApply: {
      en: 'Choose at least one section and at least one KPM to apply the template to.',
      id: 'Pilih minimal satu bagian dan minimal satu KPM untuk diterapkan.',
    },
    unknownKind: ({ kinds }: { kinds: readonly string[] }) => ({
      en: `${list(kinds)} is not a section a template holds.`,
      id: `${list(kinds)} bukan bagian yang dimiliki template.`,
    }),
    builtInReachesNobody: {
      en: 'A built-in template is copied into a company, never pushed: its KPMs belong to other companies. '
        + 'Push from the company’s own template instead.',
      id: 'Template bawaan disalin ke perusahaan, tidak pernah diterapkan langsung: KPM-nya milik perusahaan lain. '
        + 'Terapkan dari template milik perusahaan itu saja.',
    },
    notPublished: ({ kinds }: { kinds: readonly string[] }) => ({
      en: `This template has published nothing of ${list(kinds)}, so there is nothing to apply.`,
      id: `Template ini belum menerbitkan apa pun untuk ${list(kinds)}, jadi tidak ada yang dapat diterapkan.`,
    }),
    ratioTypesMissing: ({ codes }: { codes: readonly string[] }) => ({
      en: `This KPM has no active activity type ${list(codes)}, which the template’s ratios count. `
        + 'Apply the activity types with the ratios.',
      id: `KPM ini tidak memiliki jenis aktivitas aktif ${list(codes)}, yang dihitung oleh ratio template. `
        + 'Terapkan jenis aktivitas bersama ratio-nya.',
    }),
    checklistModulesMissing: ({ codes }: { codes: readonly string[] }) => ({
      en: `This KPM does not offer the training module ${list(codes)}, which the template’s checklist links to. `
        + 'Apply the training with the checklist.',
      id: `KPM ini tidak menawarkan modul training ${list(codes)}, yang ditautkan checklist template. `
        + 'Terapkan training bersama checklist-nya.',
    }),
    earlierKindRefused: {
      en: 'Not applied, because a section before it was refused for this KPM.',
      id: 'Tidak diterapkan, karena bagian sebelumnya ditolak untuk KPM ini.',
    },
  },
  TEMPLATE_APPLY_UNCONFIRMED: {
    unconfirmed: ({ codes }: { codes: readonly string[] }) => ({
      en: `KPM ${list(codes)} changed this section itself, and applying the template would replace those changes. `
        + 'Confirm the replacement for each, and apply again.',
      id: `KPM ${list(codes)} sudah mengubah bagian ini sendiri, dan menerapkan template akan mengganti perubahan itu. `
        + 'Konfirmasi penggantian untuk setiap KPM, lalu terapkan lagi.',
    }),
  },
});

