// loam-keycard — the enrollment + session manager around the raw card driver (keycard.ts).
// App-agnostic: it owns the custody UX (enroll once, implicit PIN unlock, tap-per-sign, session
// PIN cache) and hands back RAW signature material; the app maps that onto its own event/wire.
//
// Custody UX (logos-sync ADR 0008/0009):
//   • Enroll once (PIN + pairing) → the card's address becomes your identity; address/pubkey +
//     pairing password persist (SecureStore). The PIN is NEVER persisted.
//   • Implicit unlock: when a sign is attempted while locked, the session asks the UI for the PIN
//     (registered pinProvider → a modal). That first tap verifies the PIN *and* signs (one tap).
//     The PIN is then cached in memory for the session; later signs are just a tap.
//   • Wrong PIN clears the cache so the next attempt re-prompts. lock() drops the session.
//
// Reuse: call createKeycardSession({ storagePrefix }) once per app (namespaced storage so several
// Loam apps can each enrol their own card binding). For logos-sync authoring, wrap signDigest in
// an AsyncSigner: `{ pub: sess.pubHex()!, signAsync: (d) => sess.signDigest(d).then(s => s.compact) }`.
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha256";
import { signDigestOnCard } from "./keycard";
import { domainToSignPath } from "./paths";

export type KCState = "idle" | "tap";
export interface KeycardEnrollment { address: string; pubHex: string }
export interface KeycardSignResult { compact: Uint8Array; pubCompressed: Uint8Array; pubHex: string; address: string }
export interface KeycardSessionOpts {
  /** Namespace for SecureStore keys, e.g. "scala-keycard" → scala-keycard-address/pubhex/pairing. */
  storagePrefix: string;
  /** Pairing password used until the user enrols their own. */
  defaultPairing?: string;
  /**
   * App domain → the card signs at domainToSignPath(domain) = m/43'/60'/1582'/…, so the same card
   * yields the SAME identity here and in Basecamp's keycard module `requestSign({domain})`. Omit
   * for the legacy fixed path (m/44'/60'/0'/0). Changing this changes the derived address → users
   * must re-enrol (bump storagePrefix to force a clean re-enrol).
   */
  signingDomain?: string;
  /** Explicit BIP32 path override; takes precedence over signingDomain. */
  signingPath?: string;
}

const HEXC = "0123456789abcdef";
function hex(b: Uint8Array): string { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; }
// address = last 20 bytes of sha256(compressed pubkey), 0x-prefixed. Same derivation the Loam
// apps use for a software key, so a card identity and a soft identity are the same kind of thing.
export function addressForPub(pubCompressed: Uint8Array): string { return "0x" + hex(sha256(pubCompressed)).slice(24, 64); }
function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }

export interface KeycardSession {
  loadEnrollment(): Promise<KeycardEnrollment | null>;
  isEnrolled(): boolean;
  address(): string | null;
  pubHex(): string | null;
  hasSession(): boolean;
  lock(): void;
  unenroll(): Promise<void>;
  statusLine(): string;
  setPinProvider(fn: (() => Promise<string | null>) | null): void;
  onState(l: (s: KCState) => void): () => void;
  enroll(pin: string, pairing: string): Promise<KeycardEnrollment>;
  /** Sign a raw 32-byte digest on the card (implicit-unlock + tap + PIN cache). Throws "cancelled". */
  signDigest(digest32: Uint8Array): Promise<KeycardSignResult>;
}

export function createKeycardSession(opts: KeycardSessionOpts): KeycardSession {
  const ADDR_KEY = opts.storagePrefix + "-address";
  const PUB_KEY = opts.storagePrefix + "-pubhex";
  const PAIR_KEY = opts.storagePrefix + "-pairing";
  const DEFAULT_PAIRING = opts.defaultPairing ?? "KeycardDefaultPairing";
  // The BIP32 path the card signs at (enroll + every sign). undefined → driver's legacy default.
  const signPath: string | undefined = opts.signingPath ?? (opts.signingDomain ? domainToSignPath(opts.signingDomain) : undefined);

  let enrolled: KeycardEnrollment | null = null;
  let pairingPw = DEFAULT_PAIRING;
  let sessionPin: string | null = null;
  let loaded = false;
  let pinProvider: (() => Promise<string | null>) | null = null;

  let state: KCState = "idle";
  let listeners: ((s: KCState) => void)[] = [];
  const setState = (s: KCState) => { state = s; for (const l of listeners) { try { l(s); } catch { /* */ } } };

  async function ensurePin(): Promise<string> {
    if (sessionPin) return sessionPin;
    if (!pinProvider) throw new Error("keycard: locked (no PIN prompt available)");
    const pin = await pinProvider();
    if (pin == null || pin === "") throw new Error("cancelled");
    sessionPin = pin; // cached; cleared on a PIN failure below
    return pin;
  }

  return {
    async loadEnrollment() {
      if (loaded) return enrolled;
      try {
        const a = await SecureStore.getItemAsync(ADDR_KEY);
        const p = await SecureStore.getItemAsync(PUB_KEY);
        const pw = await SecureStore.getItemAsync(PAIR_KEY);
        if (a && p) enrolled = { address: a, pubHex: p };
        if (pw) pairingPw = pw;
      } catch { /* */ }
      loaded = true;
      return enrolled;
    },
    isEnrolled() { return !!enrolled; },
    address() { return enrolled ? enrolled.address : null; },
    pubHex() { return enrolled ? enrolled.pubHex : null; },
    hasSession() { return !!sessionPin; },
    lock() { sessionPin = null; },
    statusLine() {
      if (!enrolled) return "not set up";
      return (sessionPin ? "unlocked · " : "locked · ") + enrolled.address.slice(0, 12) + "…";
    },
    async unenroll() {
      enrolled = null; sessionPin = null; pairingPw = DEFAULT_PAIRING;
      try { await SecureStore.deleteItemAsync(ADDR_KEY); await SecureStore.deleteItemAsync(PUB_KEY); await SecureStore.deleteItemAsync(PAIR_KEY); } catch { /* */ }
    },
    setPinProvider(fn) { pinProvider = fn; },
    onState(l) { listeners.push(l); l(state); return () => { listeners = listeners.filter((x) => x !== l); }; },

    async enroll(pin, pairing) {
      setState("tap");
      try {
        const sig = await signDigestOnCard(sha256(utf8("loam-keycard-enroll-v1")), { pin, pairingPassword: pairing, path: signPath });
        enrolled = { address: addressForPub(sig.pubCompressed), pubHex: hex(sig.pubCompressed) };
        pairingPw = pairing; sessionPin = pin; loaded = true;
        await SecureStore.setItemAsync(ADDR_KEY, enrolled.address);
        await SecureStore.setItemAsync(PUB_KEY, enrolled.pubHex);
        await SecureStore.setItemAsync(PAIR_KEY, pairing);
        return enrolled;
      } finally { setState("idle"); }
    },

    async signDigest(digest32) {
      if (!enrolled) throw new Error("keycard: not set up");
      const pin = await ensurePin();
      setState("tap");
      try {
        const sig = await signDigestOnCard(digest32, { pin, pairingPassword: pairingPw, path: signPath });
        return { compact: sig.compact, pubCompressed: sig.pubCompressed, pubHex: enrolled.pubHex, address: enrolled.address };
      } catch (e: any) {
        if (/pin/i.test(String((e && e.message) || e))) sessionPin = null; // wrong PIN → re-prompt next time
        throw e;
      } finally { setState("idle"); }
    },
  };
}
