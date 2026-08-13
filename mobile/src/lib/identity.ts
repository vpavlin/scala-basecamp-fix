// Per-device signing identity + event authentication (secp256k1). BYTE-PARITY with the
// desktop core (src/scala_identity.hpp) — a phone-signed event verifies on the desktop
// and vice-versa. This is the AUTHENTICITY layer (who authored an event), orthogonal to
// the AES-GCM calendar seal (confidentiality). It turns roles from attribution into
// enforcement: a forged author claim can't produce a valid signature, so the fold drops it.
//
//   address(pub)     = "0x" + hex(sha256(pub_compressed_33B))[24:64]   (last 20 bytes)
//   canonicalMessage = "scala-sig-v1|"+type+"|"+wall+"|"+ctr+"|"+dev+"|"+id+"|"+cjson(payload)
//   cjson            = compact JSON, object keys sorted, no spaces
//   digest           = sha256(utf8(canonicalMessage))
//   sig              = secp256k1 ECDSA over digest, compact r||s (64B) hex, low-S
// The private key never leaves the device (SecureStore).
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Bytes } from "./utf8";

const HEXC = "0123456789abcdef";
export function hex(b: Uint8Array): string { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; }
export function fromHex(s: string): Uint8Array { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

// address = "0x" + last 20 bytes of sha256(compressed pubkey), lowercase hex (SHA-256, not
// keccak, so OpenSSL and @noble derive it byte-identically).
export function addressFor(pubCompressed: Uint8Array): string { return "0x" + hex(sha256(pubCompressed)).slice(24, 64); }

export type Identity = { priv: Uint8Array; pub: Uint8Array; pubHex: string; address: string };

export function identityFromPriv(priv: Uint8Array): Identity {
  const pub = secp256k1.getPublicKey(priv, true); // compressed 33B
  return { priv, pub, pubHex: hex(pub), address: addressFor(pub) };
}

// A valid secp256k1 scalar from expo-crypto (Hermes-safe RNG — NOT @noble randomBytes,
// which needs crypto.getRandomValues and throws on Hermes). Reject-and-retry the rare
// out-of-range scalar.
function freshPriv(): Uint8Array {
  for (let i = 0; i < 8; i++) {
    const p = Crypto.getRandomBytes(32);
    try { secp256k1.getPublicKey(p, true); return p; } catch { /* invalid scalar — retry */ }
  }
  throw new Error("could not generate a valid signing key");
}

let cached: Identity | null = null;
export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  let hp = await SecureStore.getItemAsync("scala-identity-key");
  if (!hp) { hp = hex(freshPriv()); await SecureStore.setItemAsync("scala-identity-key", hp); }
  cached = identityFromPriv(fromHex(hp));
  return cached;
}
export async function getAddress(): Promise<string> { return (await getIdentity()).address; }
export function shortAddr(a: string): string { return a && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a || ""; }

// Deterministic canonical form of an event's SIGNED fields (everything except pub/sig).
function cjson(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(cjson).join(",") + "]";
  if (typeof v === "object") { const ks = Object.keys(v).sort(); return "{" + ks.map((k) => JSON.stringify(k) + ":" + cjson(v[k])).join(",") + "}"; }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "null";
}
export function canonicalMessage(ev: any): string {
  const dev = (ev.hlc && ev.hlc.dev) || ev.dev || "";
  const wall = ev.hlc ? ev.hlc.wall : 0, ctr = ev.hlc ? ev.hlc.ctr : 0;
  return "scala-sig-v1|" + ev.type + "|" + wall + "|" + ctr + "|" + dev + "|" + ev.id + "|" + cjson(ev.payload || {});
}

// Stamp the event with our address as author (dev + hlc.dev) and sign. Mutates + returns ev.
export function signEvent(id: Identity, ev: any): any {
  ev.dev = id.address;
  if (ev.hlc) ev.hlc.dev = id.address;
  const digest = sha256(utf8Bytes(canonicalMessage(ev)));
  // prehash:false — sign the digest AS-IS (OpenSSL ECDSA_do_sign does the same). @noble v2
  // otherwise hashes the input again, which would not cross-verify with the desktop core.
  const sig = secp256k1.sign(digest, id.priv, { prehash: false }); // Uint8Array(64), low-S
  ev.pub = id.pubHex;
  ev.sig = hex(sig);
  return ev;
}

// True iff the event is well-signed by the key whose address it claims (dev). Never throws.
export function verifyEvent(ev: any): boolean {
  try {
    if (!ev || !ev.pub || !ev.sig || !ev.type || !ev.id) return false;
    const dev = (ev.hlc && ev.hlc.dev) || ev.dev;
    if (!dev) return false;
    const pub = fromHex(ev.pub);
    if (pub.length !== 33) return false;
    if (addressFor(pub) !== dev) return false;
    const digest = sha256(utf8Bytes(canonicalMessage(ev)));
    return secp256k1.verify(fromHex(ev.sig), digest, pub, { prehash: false });
  } catch {
    return false;
  }
}

// An event is "legacy" (pre-signing) when it carries no signature.
export function isSigned(ev: any): boolean { return !!(ev && ev.sig); }
