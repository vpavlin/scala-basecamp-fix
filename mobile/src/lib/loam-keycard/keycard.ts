// loam-keycard — the hardware AsyncSigner (logos-sync ADR 0009) built on the choppu Keycard
// stack (react-native-keycard + keycard-sdk). The card signs the RAW 32-byte digest on-chip;
// this module wraps the event-driven NFC flow in a promise and applies the three adapters the
// SDK's raw output needs before logos-sync/@noble will accept it:
//   1. r/s come as minimal-length big-endian → left-pad each to 32 (→ 64-byte compact r‖s)
//   2. s may be high-S → normalize to low-S (n - s) for canonical/OpenSSL-compatible sigs
//   3. the public key is uncompressed 65-byte 0x04… → compress to 33-byte for address/verify
// Iteration 1: a self-contained probe (sign a fixed digest, verify under @noble). Iteration 2
// wires this as a logos-sync AsyncSigner into scala's event authoring. Lives in scala today,
// destined for a standalone loam-keycard package (sibling to loam-transport).
import RNKeycard from "react-native-keycard";
import { KeycardManager, LOADED } from "keycard-sdk/dist/keycard-manager";
import type { Commandset } from "keycard-sdk/dist/commandset";
import { RecoverableSignature } from "keycard-sdk/dist/recoverable-signature";
import { secp256k1 } from "@noble/curves/secp256k1";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";

// The Keycard CA public key (card-authenticity cert, Secure Channel V2). Copied verbatim from
// the choppu example — same value keycard-cli / status use to verify a genuine card.
const AUTH_CERT = new Uint8Array([
  0x02, 0x9a, 0xb9, 0x9e, 0xe1, 0xe7, 0xa7, 0x1b, 0xdf, 0x45, 0xb3, 0xf9, 0xc5, 0x8c, 0x99, 0x86,
  0x6f, 0xf1, 0x29, 0x4d, 0x2c, 0x1e, 0x30, 0x4e, 0x22, 0x8a, 0x86, 0xe1, 0x0c, 0x33, 0x43, 0x50, 0x1c,
]);
// Default derivation path used by the example; loam identity will pin its own (EIP-1581 subtree
// for delegation later). Any BIP32 path works — the card signs the digest under it.
export const KEYCARD_PATH = "m/44'/60'/0'/0";

// KeycardManager needs a PairingStorage INSTANCE (RNKeycard.PairingStorage is the class).
const kManager = new KeycardManager(new (RNKeycard as any).PairingStorage());

// Lets the UI cancel an in-flight tap (stops NFC + rejects the pending sign) so a user is never
// trapped under the "hold your card" overlay.
let activeAbort: (() => void) | null = null;
export function abortKeycardSign(): void { if (activeAbort) activeAbort(); }

// The pairing password → 32-byte secret (PBKDF2-HMAC-SHA256, 50k iters, fixed salt), exactly as
// the applet/spec derive it. @noble/hashes pbkdf2 (Hermes-safe; no node crypto).
export function pairingSecret(pairingPassword: string): Uint8Array {
  return pbkdf2(sha256, new TextEncoder().encode(pairingPassword),
    new TextEncoder().encode("Keycard Pairing Password Salt"), { c: 50000, dkLen: 32 });
}

// ── adapters ─────────────────────────────────────────────────────────────────
const N = secp256k1.CURVE.n;
function pad32(b: Uint8Array): Uint8Array { const o = new Uint8Array(32); o.set(b.subarray(Math.max(0, b.length - 32)), 32 - Math.min(32, b.length)); return o; }
function toBigInt(b: Uint8Array): bigint { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
function toBytes32(x: bigint): Uint8Array { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; }
function lowS(s: Uint8Array): Uint8Array { const v = toBigInt(s); return v > N / 2n ? toBytes32(N - v) : pad32(s); }
// uncompressed 65B (0x04‖X‖Y) → 33-byte compressed (0x02/0x03 by Y-parity ‖ X). Done by hand
// so it can't trip on a @noble API rename (ProjectivePoint vs Point) or a Hermes quirk.
export function compressPub(pub: Uint8Array): Uint8Array {
  if (pub.length === 33) return pub;
  if (pub.length === 65 && pub[0] === 0x04) {
    const out = new Uint8Array(33);
    out[0] = (pub[64] & 1) === 0 ? 0x02 : 0x03; // even Y → 0x02, odd Y → 0x03
    out.set(pub.subarray(1, 33), 1);            // X
    return out;
  }
  return pub;
}
// (r,s) from the card → 64-byte compact r‖s, low-S normalized (what logos-sync/@noble verify).
export function toCompactSig(r: Uint8Array, s: Uint8Array): Uint8Array {
  const out = new Uint8Array(64); out.set(pad32(r), 0); out.set(lowS(s), 32); return out;
}

export type KeycardSig = { r: Uint8Array; s: Uint8Array; pub: Uint8Array; compact: Uint8Array; pubCompressed: Uint8Array };

// Sign a raw 32-byte digest on the card. Drives the NFC lifecycle: startNFC → wait for the tap
// → open secure channel + verify PIN + sign under `path` → stopNFC. ALWAYS stops NFC on every
// exit path (the example wedges its reader by not doing this — see keycard-loam-identity memory).
export function signDigestOnCard(
  digest32: Uint8Array,
  opts: { pin: string; pairingPassword: string; path?: string },
): Promise<KeycardSig> {
  const path = opts.path || KEYCARD_PATH;
  return new Promise<KeycardSig>((resolve, reject) => {
    let settled = false;
    let sub: { remove: () => void } | null = null;
    const finish = (fn: () => void) => {
      if (settled) return; settled = true;
      activeAbort = null;
      try { sub && sub.remove(); } catch { /* */ }
      RNKeycard.Core.stopNFC().catch(() => { /* */ }).finally(fn);
    };
    activeAbort = () => finish(() => reject(new Error("cancelled")));
    try {
      sub = RNKeycard.Core.onKeycardConnected(async () => {
        try {
          const channel = new (RNKeycard as any).NFCCardChannel();
          const res: any = await kManager.runOnSecureChannel(
            channel, LOADED,
            { pin: opts.pin, pairingPassword: pairingSecret(opts.pairingPassword), cardPublicKeys: [AUTH_CERT], skipVerificationUID: [] } as any,
            async (cmdSet: Commandset) => {
              const tlv = (await cmdSet.signWithPath(digest32, path, false)).checkOK().data;
              const rs = new RecoverableSignature({ hash: digest32, tlvData: tlv });
              return { r: rs.r as Uint8Array, s: rs.s as Uint8Array, pub: rs.publicKey as Uint8Array };
            },
          );
          // runOnSecureChannel nests the cbFunc's return under res.data.cbFuncResponse (NOT
          // res.data), and success is NOT a res.status==="ok" flag. Treat a present r/s/pub as
          // success. The RN/nitro bridge may hand the byte arrays across as {0:..,1:..} objects.
          const data: any = (res && (res.data ?? res)) || {};
          const cb: any = data.cbFuncResponse || {};
          const u8 = (x: any): Uint8Array => (x instanceof Uint8Array ? x : Uint8Array.from(Object.values(x || {}) as number[]));
          if (cb.r && cb.s && cb.pub && data.cardAuthentic !== false) {
            const r = u8(cb.r), s = u8(cb.s), pub = u8(cb.pub);
            const pubCompressed = compressPub(pub);
            finish(() => resolve({ r, s, pub, compact: toCompactSig(r, s), pubCompressed }));
          } else {
            finish(() => reject(new Error("keycard: " + JSON.stringify(data))));
          }
        } catch (e) { finish(() => reject(e as Error)); }
      });
      RNKeycard.Core.startNFC("Tap your Keycard to sign").catch((e) => finish(() => reject(e)));
    } catch (e) { finish(() => reject(e as Error)); }
  });
}

// Iteration-1 probe: sign a fixed digest, apply the adapters, and confirm the sig verifies under
// @noble against the card's (compressed) key — the smoke-test's check #4, now inside scala with
// the real adapter path. Returns the outcome for the UI.
export async function keycardProbe(pin: string, pairingPassword: string): Promise<{ pass: boolean; pubHex: string; sigHex: string; detail: string }> {
  const digest = sha256(new TextEncoder().encode("loam-keycard-probe-v1"));
  const sig = await signDigestOnCard(digest, { pin, pairingPassword });
  const pass = secp256k1.verify(sig.compact, digest, sig.pubCompressed);
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { pass, pubHex: hex(sig.pubCompressed), sigHex: hex(sig.compact), detail: pass ? "card sig verifies under @noble ✓" : "VERIFY FAILED — adapter mismatch" };
}
