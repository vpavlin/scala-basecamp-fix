// loam-keycard × scala — the card is your scala identity; each authored event is signed ON the
// card (tap-per-sign). This is the THIN app shim: all custody/session logic (enroll, implicit PIN
// unlock, tap-per-sign, PIN cache, state bus) now lives in the reusable session.ts / keycard.ts
// (the loam-keycard package, vendored here). Here we only map scala's event onto the card's raw
// sign — set author = card address, digest scala's canonical form, stamp pub/sig.
//
// Public surface is unchanged from the pre-extraction signer, so identities.ts and KeycardProbe.tsx
// are untouched. To share with kym/qaku/perun: vendor keycard.ts + session.ts and write a shim like
// this one against your own event's canonical form + domain.
import { sha256 } from "@noble/hashes/sha256";
import { canonicalMessage, hex } from "../identity";
import { utf8Bytes } from "../utf8";
import { createKeycardSession, type KCState } from "./session";

// One session for scala; SecureStore keys namespaced scala-keycard-address/pubhex/pairing.
const kc = createKeycardSession({ storagePrefix: "scala-keycard", defaultPairing: "KeycardDefaultPairing" });

export type { KCState };
export function setPinProvider(fn: (() => Promise<string | null>) | null): void { kc.setPinProvider(fn); }
export function onKeycardState(l: (s: KCState) => void): () => void { return kc.onState(l); }
export function loadEnrollment(): Promise<{ address: string; pubHex: string } | null> { return kc.loadEnrollment(); }
export function isKeycardIdentity(): boolean { return kc.isEnrolled(); }
export function keycardAddress(): string | null { return kc.address(); }
export function keycardPubHex(): string | null { return kc.pubHex(); }
export function hasSession(): boolean { return kc.hasSession(); }
export function lockKeycard(): void { kc.lock(); }
export function keycardStatusLine(): string { return kc.statusLine(); }
export function unenroll(): Promise<void> { return kc.unenroll(); }
export function enrollKeycard(pin: string, pairing: string): Promise<{ address: string; pubHex: string }> { return kc.enroll(pin, pairing); }

// Sign one scala event ON the card. Prompts for the PIN if locked (implicit unlock, via the
// session), taps once (verify PIN + sign), caches the PIN. Wrong PIN → the session re-prompts next.
export async function signEventWithKeycard(ev: any): Promise<any> {
  const addr = kc.address();
  if (!addr) throw new Error("keycard: not set up");
  ev.dev = addr;
  if (ev.hlc) ev.hlc.dev = addr;
  const digest = sha256(utf8Bytes(canonicalMessage(ev)));
  const sig = await kc.signDigest(digest);
  ev.pub = sig.pubHex;
  ev.sig = hex(sig.compact);
  return ev;
}
