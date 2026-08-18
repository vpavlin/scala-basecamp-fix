// loam-keycard — deterministic domain → BIP32 path derivation. BYTE-FOR-BYTE compatible with
// Alisher's keycard-basecamp (keycard-core/src/plugin.cpp domainToIndices/domainToSignPath), so a
// card signs the SAME key whether driven by this mobile stack (react-native-keycard signWithPath)
// or by the desktop keycard module (`logos.callModule("keycard","requestSign",{domain})`). That
// path-equality is what lets one physical card be one identity across phone (NFC) and Basecamp
// (PC/SC) — see the keycard-loam-identity notes.
//
//   idx = SHA256("logos-" + domain) → first 16 bytes as four big-endian uint32, each & 0x7FFFFFFF
//   signing path (non-exportable subtree): m/43'/60'/1582'/idx0'/idx1'/idx2'/idx3'
//   auth/derive path (EIP-1581, exportable):  m/43'/60'/1581'/idx0'/idx1'/idx2'/idx3'
import { sha256 } from "@noble/hashes/sha256";

export function domainToIndices(domain: string): [number, number, number, number] {
  const h = sha256(new TextEncoder().encode("logos-" + domain));
  // (h0<<24 | h1<<16 | h2<<8 | h3) & 0x7FFFFFFF — the trailing mask yields a non-negative int31 in
  // JS, matching C++'s `uint32_t(...) & 0x7FFFFFFF` bit-for-bit (drops the hardened/sign bit).
  const at = (o: number) => (((h[o] << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) & 0x7fffffff);
  return [at(0), at(4), at(8), at(12)];
}

/** Non-exportable signing subtree (1582'). Use this for on-card event signing (key can't leave). */
export function domainToSignPath(domain: string): string {
  const i = domainToIndices(domain);
  return `m/43'/60'/1582'/${i[0]}'/${i[1]}'/${i[2]}'/${i[3]}'`;
}

/** EIP-1581 exportable subtree (1581'). Use this only when you genuinely need the key bytes (encryption). */
export function domainToKeyPath(domain: string): string {
  const i = domainToIndices(domain);
  return `m/43'/60'/1581'/${i[0]}'/${i[1]}'/${i[2]}'/${i[3]}'`;
}
