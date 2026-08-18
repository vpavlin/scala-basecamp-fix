// loam-keycard × scala — the card is your scala identity; each authored event is signed ON the
// card (tap-per-sign). Custody UX:
//   • Enroll once (PIN + pairing) → the card's address becomes your identity; address/pubkey +
//     pairing password are persisted (SecureStore). PIN is NEVER persisted.
//   • Implicit unlock: when a sign is attempted while locked, the signer asks the UI for the PIN
//     (registered pinProvider → a modal). That first tap verifies the PIN *and* signs the event
//     (one tap). The PIN is then cached in memory for the session → later edits are just a tap.
//   • Wrong PIN clears the cache so the next attempt re-prompts. lockKeycard() drops the session.
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalMessage, addressFor, hex } from "../identity";
import { utf8Bytes } from "../utf8";
import { signDigestOnCard } from "./keycard";

const ADDR_KEY = "scala-keycard-address";
const PUB_KEY = "scala-keycard-pubhex";
const PAIR_KEY = "scala-keycard-pairing"; // pairing password (needed to open the secure channel)

let enrolled: { address: string; pubHex: string } | null = null;
let pairingPw = "KeycardDefaultPairing";
let sessionPin: string | null = null;
let loaded = false;

// The UI registers this; the signer calls it when it needs a PIN and none is cached.
let pinProvider: (() => Promise<string | null>) | null = null;
export function setPinProvider(fn: (() => Promise<string | null>) | null): void { pinProvider = fn; }

// ── UI state bus (idle | tap) for the "hold your card" overlay ──
export type KCState = "idle" | "tap";
let state: KCState = "idle";
type L = (s: KCState) => void;
let listeners: L[] = [];
export function onKeycardState(l: L): () => void { listeners.push(l); l(state); return () => { listeners = listeners.filter((x) => x !== l); }; }
function setState(s: KCState) { state = s; for (const l of listeners) { try { l(s); } catch { /* */ } } }

export async function loadEnrollment(): Promise<{ address: string; pubHex: string } | null> {
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
}
export function isKeycardIdentity(): boolean { return !!enrolled; }
export function keycardAddress(): string | null { return enrolled ? enrolled.address : null; }
export function keycardPubHex(): string | null { return enrolled ? enrolled.pubHex : null; }
export function hasSession(): boolean { return !!sessionPin; }
export function lockKeycard(): void { sessionPin = null; }
export function keycardStatusLine(): string {
  if (!enrolled) return "not set up";
  return (sessionPin ? "unlocked · " : "locked · ") + enrolled.address.slice(0, 12) + "…";
}
export async function unenroll(): Promise<void> {
  enrolled = null; sessionPin = null; pairingPw = "KeycardDefaultPairing";
  try { await SecureStore.deleteItemAsync(ADDR_KEY); await SecureStore.deleteItemAsync(PUB_KEY); await SecureStore.deleteItemAsync(PAIR_KEY); } catch { /* */ }
}

// Enroll: tap once, recover the card's pubkey, derive the address = your scala identity. Persist
// address/pubkey/pairing; open the session.
export async function enrollKeycard(pin: string, pairing: string): Promise<{ address: string; pubHex: string }> {
  setState("tap");
  try {
    const sig = await signDigestOnCard(sha256(utf8Bytes("loam-keycard-enroll-v1")), { pin, pairingPassword: pairing });
    enrolled = { address: addressFor(sig.pubCompressed), pubHex: hex(sig.pubCompressed) };
    pairingPw = pairing; sessionPin = pin; loaded = true;
    await SecureStore.setItemAsync(ADDR_KEY, enrolled.address);
    await SecureStore.setItemAsync(PUB_KEY, enrolled.pubHex);
    await SecureStore.setItemAsync(PAIR_KEY, pairing);
    return enrolled;
  } finally { setState("idle"); }
}

// Get a PIN: cached if unlocked, else ask the UI (implicit unlock). Throws "cancelled" if dismissed.
async function ensurePin(): Promise<string> {
  if (sessionPin) return sessionPin;
  if (!pinProvider) throw new Error("keycard: locked (no PIN prompt available)");
  const pin = await pinProvider();
  if (pin == null || pin === "") throw new Error("cancelled");
  sessionPin = pin; // cached; cleared below on a PIN failure
  return pin;
}

// Sign one scala event ON the card. Prompts for the PIN if locked (implicit unlock), taps once
// (verify PIN + sign), caches the PIN for the session. Wrong PIN → clear cache so we re-prompt.
export async function signEventWithKeycard(ev: any): Promise<any> {
  if (!enrolled) throw new Error("keycard: not set up");
  const pin = await ensurePin();
  ev.dev = enrolled.address;
  if (ev.hlc) ev.hlc.dev = enrolled.address;
  const digest = sha256(utf8Bytes(canonicalMessage(ev)));
  setState("tap");
  try {
    const sig = await signDigestOnCard(digest, { pin, pairingPassword: pairingPw });
    ev.pub = enrolled.pubHex;
    ev.sig = hex(sig.compact);
    return ev;
  } catch (e: any) {
    if (/pin/i.test(String((e && e.message) || e))) sessionPin = null; // wrong PIN → re-prompt next time
    throw e;
  } finally { setState("idle"); }
}
