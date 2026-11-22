import { refusals } from '@/common/i18n/sentence';

/**
 * **What adding and removing a KPM's owners refuses with** (P19.27-T1 AC-4; ADR-0285 §4), in both languages — the copy
 * the stop motion's section C gives where it gives one (*"Tambah owner lain dulu"*).
 */
export const KPM_OWNERS_REFUSALS = refusals('tenants/kpm-owners', {
  KPM_LAST_OWNER: {
    /** The one owner left (ADR-0285 §4): a KPM is never without an owner. */
    lastOwner: ({ name }: { name: string }) => ({
      en: `${name} is this KPM's only owner, and a KPM always has one. Add another owner first.`,
      id: `${name} adalah satu-satunya owner KPM ini, dan KPM selalu punya owner. Tambah owner lain dulu.`,
    }),
  },
  PERM_OWNER_ONLY: {
    /** An owner removing themselves (OD-452): another owner, or the Super Admin, does it. */
    ownOwnership: {
      en: 'You cannot remove yourself as an owner. Another owner, or the Super Admin, can.',
      id: 'Anda tidak bisa menghapus diri sendiri sebagai owner. Owner lain, atau Super Admin, yang bisa.',
    },
  },
});
