import mongoose from 'mongoose';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';

/**
 * **Two KPMs whose Owner is waiting to be invited by WhatsApp** (P19.23-T2 AC-3; ADR-0277; OD-420), so *Kirim undangan*
 * can be walked both ways from the Super Admin's console.
 *
 * | KPM | Its Owner | Signed in as `superadmin@agencyboost.test`, *Kirim undangan* gives |
 * |---|---|---|
 * | **0418** Serpong Branch (Prudential) | **BUDI HARTONO**, named with a WhatsApp number and no email — no account (*Belum diundang*) | a **claim link**, `/owner-invite/<token>`: open it signed out to see the banner; sign in as `budi.hartono@kpm0418.test` (verified, Prudential, an agent code) and *Terima & jadi owner* makes him the Owner |
 * | **0419** Alam Sutera Branch (Prudential) | **Rina Kurniawati** (`owner@kpm0419.test`), an account that has never signed in | the **password link**, `/reset-password/<token>`, which her own invitation email would carry |
 *
 * `budi.hartono@kpm0418.test` is an account of Prudential with no KPM yet — the person the claim link is for, as if he
 * had signed up. Every field account signs in with the seed's field password. **Written once, until `--reset`**: the
 * offices are found by their code, the accounts by their address, and the pending Owner is set only while the KPM has
 * no Owner and none named.
 */
export const OWNER_WHATSAPP_SEED = {
  pending: {
    code: '0418', branchName: 'Serpong Branch',
    owner: { fullName: 'BUDI HARTONO', phone: '+6281234567890' },
    claimer: { email: 'budi.hartono@kpm0418.test', fullName: 'Budi Hartono', agentCode: '81941' },
  },
  neverSignedIn: {
    code: '0419', branchName: 'Alam Sutera Branch',
    owner: { email: 'owner@kpm0419.test', fullName: 'Rina Kurniawati', agentCode: '81942' },
  },
} as const;

type Office = { _id: unknown; code: string; companyId: string };

export interface OwnerWhatsAppFixtureDeps {
  companyId: string;
  /** `demo.ts`'s office writer: an office of that company and code made before is found. */
  office: (companyId: string, code: string, branchName: string, opts?: { ownerUserId?: string }) => Promise<Office>;
  /** `demo.ts`'s provisioning mirror, guarded per collection: the KPM's settings screens are not empty. */
  configure: (kpmId: string) => Promise<unknown>;
  /** `demo.ts`'s account writer: an address it made before is found. */
  user: (
    email: string, fullName: string, opts: { agentCode: string; companyId: string; pronoun: 'he' | 'she' },
  ) => Promise<{ _id: unknown }>;
  /** Places an account as the KPM's root AB, as `demo.ts` places anybody; a membership made before is found. */
  placeOwner: (office: Office, userId: string) => Promise<unknown>;
}

export interface OwnerWhatsAppFixture {
  pendingKpmId: string;
  ownedKpmId: string;
  guide: string;
}

export async function seedOwnerWhatsAppFixture(deps: OwnerWhatsAppFixtureDeps): Promise<OwnerWhatsAppFixture> {
  const Kpms = mongoose.models[Kpm.name] ?? mongoose.model(Kpm.name, KpmSchema);
  const { pending, neverSignedIn } = OWNER_WHATSAPP_SEED;

  // 0418: an Owner named with a WhatsApp number and no email, waiting; and the account he would sign up with.
  const serpong = await deps.office(deps.companyId, pending.code, pending.branchName);
  await deps.configure(String(serpong._id));
  await Kpms.updateOne(
    { _id: serpong._id, ownerUserId: null, pendingOwner: null },
    { $set: { pendingOwner: { fullName: pending.owner.fullName, phone: pending.owner.phone, agentCode: null } } },
  ).exec();
  await deps.user(pending.claimer.email, pending.claimer.fullName, {
    agentCode: pending.claimer.agentCode, companyId: deps.companyId, pronoun: 'he',
  });

  // 0419: an Owner with an account that has never signed in.
  const rina = await deps.user(neverSignedIn.owner.email, neverSignedIn.owner.fullName, {
    agentCode: neverSignedIn.owner.agentCode, companyId: deps.companyId, pronoun: 'she',
  });
  const alamSutera = await deps.office(deps.companyId, neverSignedIn.code, neverSignedIn.branchName, {
    ownerUserId: String(rina._id),
  });
  await deps.configure(String(alamSutera._id));
  await deps.placeOwner(alamSutera, String(rina._id));

  return {
    pendingKpmId: String(serpong._id),
    ownedKpmId: String(alamSutera._id),
    guide: `Owner invited by WhatsApp (P19.23-T2 AC-3): KPM ${pending.code} ${pending.branchName} waits for `
      + `${pending.owner.fullName} (WhatsApp only — Kirim undangan gives a claim link; accept it signed in as `
      + `${pending.claimer.email}); KPM ${neverSignedIn.code} ${neverSignedIn.branchName}'s Owner `
      + `${neverSignedIn.owner.email} has never signed in (Kirim undangan gives her password link).`,
  };
}
