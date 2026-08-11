// AES key derivation from a calendar's `encryptionKey` string — pure, no deps, so
// it's unit-testable against the C ground truth (see test/crypto-parity.sh).
//
// Must match the desktop core (src/calendar_sync.cpp) EXACTLY, per byte i in 0..31:
//     sscanf(keyHex + i*2, "%2hhx", &key[i])
// The encryptionKey is two concatenated UUIDv4 strings, so it contains DASHES at
// fixed positions. The subtlety that broke cross-platform interop: C `%x` accepts
// an optional leading SIGN, and the field width (2) counts it. So a window starting
// on a dash — e.g. "-a" — parses as sign '-' + one hex digit 'a' = -10, stored in an
// unsigned char as 0xf6 (NOT 0). A dashed UUID key therefore yields negative bytes at
// every dash boundary. DO NOT "fix" this to a clean hex decode — it would change the
// key and break every peer.

// Reproduce C `sscanf(p, "%2hhx", &out)` starting at string offset `off`.
export function sscanf2hhx(s: string, off: number): number {
  const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
  let i = off;
  while (i < s.length && /\s/.test(s[i])) i++; // %x skips leading whitespace
  let width = 2;
  let sign = 1;
  if (i < s.length && (s[i] === "-" || s[i] === "+")) {
    sign = s[i] === "-" ? -1 : 1;
    i++;
    width--; // the sign consumes one char of the field width
  }
  let hex = "";
  while (i < s.length && width > 0 && isHex(s[i])) { hex += s[i]; i++; width--; }
  if (hex === "") return 0; // no hex digits → conversion fails → C leaves the byte 0
  return (parseInt(hex, 16) * sign) & 0xff;
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
