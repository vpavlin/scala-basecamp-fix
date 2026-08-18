// identities.ts — scala's binding into the generic loam-keycard identity registry.
//
// The whole multi-identity model (device/soft/keycard registry, per-container binding, default,
// authorEvent routing) now lives in loam-keycard (src/lib/loam-keycard/identity.ts, vendored). Here
// we only INJECT scala's own seams — its software-key signing (identity.ts) and its Keycard signer
// (loam-keycard/scala-signer) — and keep the calendar-flavoured names the app already imports.
//
// Storage prefix "scala" → identical keys to the pre-extraction module (scala.identities.* and
// scala-soft-<id>), so existing enrolments/bindings survive.
import * as Crypto from "expo-crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getIdentity, identityFromPriv, signEvent as signEventSoft, hex, fromHex } from "./identity";
import { isKeycardIdentity, keycardAddress, keycardPubHex, signEventWithKeycard, loadEnrollment } from "./loam-keycard/scala-signer";
import { createIdentityRegistry, SoftKeySeam, KeycardIdentitySeam } from "./loam-keycard/identity";
export type { IdentityMeta, IdKind } from "./loam-keycard/identity";

// Hermes-safe secp256k1 scalar (expo-crypto RNG; reject out-of-range).
function freshPriv(): Uint8Array {
  for (let i = 0; i < 8; i++) { const p = Crypto.getRandomBytes(32); try { secp256k1.getPublicKey(p, true); return p; } catch { /* retry */ } }
  throw new Error("could not generate a key");
}

const soft: SoftKeySeam = {
  getDeviceKey: async () => { const id = await getIdentity(); return { priv: id.priv, address: id.address, pubHex: id.pubHex }; },
  keyFromPriv: (priv) => { const id = identityFromPriv(priv); return { priv: id.priv, address: id.address, pubHex: id.pubHex }; },
  freshPriv,
  signEvent: (key, ev) => signEventSoft(identityFromPriv(key.priv), ev),
  hex, fromHex,
};
const keycard: KeycardIdentitySeam = {
  loadEnrollment,
  isEnrolled: isKeycardIdentity,
  address: keycardAddress,
  pubHex: keycardPubHex,
  signEvent: signEventWithKeycard,
};

const reg = createIdentityRegistry({ storagePrefix: "scala", soft, keycard });

// Same surface the app already imports (calendar = container).
export const listIdentities = () => reg.listIdentities();
export const addSoftIdentity = (label: string) => reg.addSoftIdentity(label);
export const renameSoftIdentity = (id: string, label: string) => reg.renameSoftIdentity(id, label);
export const removeSoftIdentity = (id: string) => reg.removeSoftIdentity(id);
export const getDefaultIdentityId = () => reg.getDefaultIdentityId();
export const setDefaultIdentityId = (id: string) => reg.setDefaultIdentityId(id);
export const bindingFor = (calId: string) => reg.bindingFor(calId);
export const bindCalendar = (calId: string, identityId: string) => reg.bindContainer(calId, identityId);
export const identityForCalendar = (calId: string) => reg.identityForContainer(calId);
export const authorEvent = (calId: string, ev: any) => reg.authorEvent(calId, ev);
export const defaultAddress = () => reg.defaultAddress();
