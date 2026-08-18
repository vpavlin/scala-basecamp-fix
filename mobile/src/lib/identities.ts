// identities.ts — multiple authoring identities + per-calendar binding.
//
// An IDENTITY is a keypair that AUTHORS events; a CALENDAR is bound to one. logos-sync's Signer
// seam already accepts a different signer per event, so this is purely app-level: which key signs
// YOUR events for a given calendar. No fold/wire/C++ change — every event is self-describing
// (pub/sig/dev) and Basecamp verifies whatever signed it.
//
// Kinds:
//   • "device"  — the built-in software key (identity.ts / scala-identity-key). Always present.
//   • "soft"    — extra named software keys you create (compartmentalise calendars without a card).
//   • "keycard" — the enrolled Keycard (hardware; signs via NFC tap). Present iff enrolled.
//
// A calendar with no explicit binding falls back to the DEFAULT identity, which itself defaults to
// the Keycard when enrolled else the device key — so existing calendars keep today's behaviour.
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getIdentity, identityFromPriv, signEvent as signEventSoft, hex, fromHex } from "./identity";
import { isKeycardIdentity, keycardAddress, keycardPubHex, signEventWithKeycard, loadEnrollment } from "./loam-keycard/scala-signer";

export type IdKind = "device" | "soft" | "keycard";
export type IdentityMeta = { id: string; kind: IdKind; label: string; address: string; pubHex: string };

const REG_KEY = "scala.identities.registry";   // [{id,label}] for soft identities (privs in SecureStore)
const BIND_KEY = "scala.identities.bindings";   // { [calId]: identityId }
const DEFAULT_KEY = "scala.identities.default";  // identityId used for new/unbound calendars
const softPrivKey = (id: string) => "scala-soft-" + id;

async function readJson<T>(k: string, d: T): Promise<T> { try { const s = await AsyncStorage.getItem(k); return s ? JSON.parse(s) : d; } catch { return d; } }
async function writeJson(k: string, v: any): Promise<void> { try { await AsyncStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } }

// Hermes-safe secp256k1 scalar (expo-crypto RNG; reject out-of-range), same as identity.ts.
function freshPriv(): Uint8Array {
  for (let i = 0; i < 8; i++) { const p = Crypto.getRandomBytes(32); try { secp256k1.getPublicKey(p, true); return p; } catch { /* retry */ } }
  throw new Error("could not generate a key");
}

async function deviceMeta(): Promise<IdentityMeta> {
  const id = await getIdentity();
  return { id: "device", kind: "device", label: "This device", address: id.address, pubHex: id.pubHex };
}
async function keycardMeta(): Promise<IdentityMeta | null> {
  await loadEnrollment();
  if (!isKeycardIdentity()) return null;
  return { id: "keycard", kind: "keycard", label: "Keycard", address: keycardAddress()!, pubHex: keycardPubHex() || "" };
}
async function softMetas(): Promise<IdentityMeta[]> {
  const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
  const out: IdentityMeta[] = [];
  for (const r of reg) {
    const hp = await SecureStore.getItemAsync(softPrivKey(r.id));
    if (!hp) continue;
    const id = identityFromPriv(fromHex(hp));
    out.push({ id: r.id, kind: "soft", label: r.label, address: id.address, pubHex: id.pubHex });
  }
  return out;
}

// All identities: device, then soft (creation order), then keycard (if enrolled).
export async function listIdentities(): Promise<IdentityMeta[]> {
  const out = [await deviceMeta(), ...(await softMetas())];
  const kc = await keycardMeta(); if (kc) out.push(kc);
  return out;
}

export async function addSoftIdentity(label: string): Promise<IdentityMeta> {
  const id = "soft-" + Crypto.randomUUID();
  const priv = freshPriv();
  await SecureStore.setItemAsync(softPrivKey(id), hex(priv));
  const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
  reg.push({ id, label: label || "Identity " + (reg.length + 1) });
  await writeJson(REG_KEY, reg);
  const k = identityFromPriv(priv);
  return { id, kind: "soft", label, address: k.address, pubHex: k.pubHex };
}
export async function renameSoftIdentity(id: string, label: string): Promise<void> {
  const reg = await readJson<{ id: string; label: string }[]>(REG_KEY, []);
  const r = reg.find((x) => x.id === id); if (r) { r.label = label; await writeJson(REG_KEY, reg); }
}
export async function removeSoftIdentity(id: string): Promise<void> {
  const reg = (await readJson<{ id: string; label: string }[]>(REG_KEY, [])).filter((x) => x.id !== id);
  await writeJson(REG_KEY, reg);
  try { await SecureStore.deleteItemAsync(softPrivKey(id)); } catch { /* */ }
  // drop any bindings that pointed at it (they fall back to default)
  const b = await readJson<Record<string, string>>(BIND_KEY, {});
  let changed = false; for (const k of Object.keys(b)) if (b[k] === id) { delete b[k]; changed = true; }
  if (changed) await writeJson(BIND_KEY, b);
}

// The default identity for new / unbound calendars. Falls back to keycard-if-enrolled-else-device
// so pre-feature calendars keep behaving as before.
export async function getDefaultIdentityId(): Promise<string> {
  const explicit = await AsyncStorage.getItem(DEFAULT_KEY);
  if (explicit) { const all = await listIdentities(); if (all.some((m) => m.id === explicit)) return explicit; }
  return (await keycardMeta()) ? "keycard" : "device";
}
export async function setDefaultIdentityId(id: string): Promise<void> { await AsyncStorage.setItem(DEFAULT_KEY, id); }

export async function bindingFor(calId: string): Promise<string | null> {
  const b = await readJson<Record<string, string>>(BIND_KEY, {}); return b[calId] ?? null;
}
export async function bindCalendar(calId: string, identityId: string): Promise<void> {
  const b = await readJson<Record<string, string>>(BIND_KEY, {}); b[calId] = identityId; await writeJson(BIND_KEY, b);
}
// The identity that authors YOUR events for this calendar (its binding, else the default).
export async function identityForCalendar(calId: string): Promise<IdentityMeta> {
  const wantId = (await bindingFor(calId)) ?? (await getDefaultIdentityId());
  const all = await listIdentities();
  return all.find((m) => m.id === wantId) ?? (await deviceMeta());
}

// Sign one event with the calendar's identity. keycard → NFC tap (async); soft/device → local.
export async function authorEvent(calId: string, ev: any): Promise<any> {
  const meta = await identityForCalendar(calId);
  if (meta.kind === "keycard") return signEventWithKeycard(ev);
  const priv = meta.kind === "device"
    ? (await getIdentity()).priv
    : fromHex((await SecureStore.getItemAsync(softPrivKey(meta.id))) || "");
  if (priv.length !== 32) throw new Error("identity key unavailable");
  return signEventSoft(identityFromPriv(priv), ev);
}

// Address of the default identity — used for the clock/senderId (per-event author is overwritten
// by authorEvent anyway).
export async function defaultAddress(): Promise<string> {
  return (await identityForCalendarDefault()).address;
}
async function identityForCalendarDefault(): Promise<IdentityMeta> {
  const wantId = await getDefaultIdentityId();
  const all = await listIdentities();
  return all.find((m) => m.id === wantId) ?? (await deviceMeta());
}
