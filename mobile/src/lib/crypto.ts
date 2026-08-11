// Scala calendar crypto — AES-256-GCM seal/open, byte-for-byte compatible with
// the desktop core (src/calendar_sync.cpp seal()/open()).
//
// Wire format of the SEALED bytes (what logos-transport carries, per calendar):
//   nonce(12) || tag(16) || ciphertext        (AES-256-GCM, no AAD)
//
// KEY DERIVATION — must match the desktop EXACTLY, quirks included:
//   The desktop stores the calendar's `encryptionKey` as a STRING and derives
//   the 32-byte AES key with, per byte i in 0..31:
//       sscanf(keyHex + i*2, "%2hhx", &key[i])
//   i.e. read up to 2 hex digits starting at char offset i*2. Because the
//   real encryptionKey is two concatenated UUID v4 strings (generateUuid() +
//   generateUuid()), it CONTAINS DASHES at fixed positions, and `%2hhx` STOPS
//   at a non-hex char — so a window like "a-" parses as just 0x0a, and a window
//   starting ON a dash (e.g. "-3") parses as 0x03 (leading '-' skipped as
//   whitespace-ish? no — sscanf %x treats '-' as an invalid start and reads
//   nothing → byte stays 0). We reproduce sscanf("%2hhx") faithfully below so
//   the derived key is identical to the desktop's, dashes and all. DO NOT
//   "fix" this to a clean hex decode — that would break interop.
import { gcm } from "@noble/ciphers/aes.js";
import * as Crypto from "expo-crypto";

// Reproduce C `sscanf(p, "%2hhx", &out)` starting at string offset `off`:
// skip nothing (scanf %x does skip leading WHITESPACE, but '-' is not
// whitespace so it is NOT skipped — it simply fails to convert), then read at
// most 2 hex digits. Returns the parsed byte, or 0 if the first char isn't hex.
function sscanf2hhx(s: string, off: number): number {
  const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
  let i = off;
  // %x in C skips leading whitespace; encryptionKey has none, but be faithful.
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length || !isHex(s[i])) return 0; // no conversion → C leaves the byte untouched (we pre-zero)
  let hex = s[i];
  i++;
  if (i < s.length && isHex(s[i])) hex += s[i];
  return parseInt(hex, 16) & 0xff;
}

/** Derive the 32-byte AES key from the calendar's encryptionKey string,
 *  reproducing the desktop's byte-by-byte sscanf("%2hhx") parse. */
export function deriveKey(encryptionKey: string): Uint8Array {
  const key = new Uint8Array(32); // pre-zeroed, matching `std::vector<unsigned char> key(32)`
  for (let i = 0; i < 32 && i * 2 < encryptionKey.length; i++) {
    key[i] = sscanf2hhx(encryptionKey, i * 2);
  }
  return key;
}

/** Seal plaintext bytes for a calendar: AES-256-GCM → nonce||tag||ciphertext,
 *  exactly the layout the desktop's open() expects. */
export function seal(encryptionKey: string, plaintext: Uint8Array): Uint8Array {
  const key = deriveKey(encryptionKey);
  const nonce = Crypto.getRandomBytes(12); // real RNG (Hermes has no WebCrypto)
  // @noble gcm returns ciphertext||tag (tag appended). The desktop packs
  // nonce||tag||ciphertext, so we split noble's output and re-pack.
  const ctAndTag = gcm(key, nonce).encrypt(plaintext);
  const tag = ctAndTag.slice(ctAndTag.length - 16);
  const ct = ctAndTag.slice(0, ctAndTag.length - 16);
  const out = new Uint8Array(12 + 16 + ct.length);
  out.set(nonce, 0);
  out.set(tag, 12);
  out.set(ct, 28);
  return out;
}

/** Open sealed bytes (nonce||tag||ciphertext). Returns null on auth failure or
 *  wrong key (so a receiver can try each key/candidate and take the first that
 *  authenticates). */
export function open(encryptionKey: string, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 28 + 16) return null; // nonce+tag+min ciphertext
  const key = deriveKey(encryptionKey);
  const nonce = sealed.slice(0, 12);
  const tag = sealed.slice(12, 28);
  const ct = sealed.slice(28);
  // Re-assemble noble's expected ciphertext||tag ordering.
  const ctAndTag = new Uint8Array(ct.length + 16);
  ctAndTag.set(ct, 0);
  ctAndTag.set(tag, ct.length);
  try {
    return gcm(key, nonce).decrypt(ctAndTag);
  } catch {
    return null; // GCM tag mismatch → wrong key / not ours / tampered
  }
}
