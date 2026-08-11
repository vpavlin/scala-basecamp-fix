// JS side of the crypto-derivation parity test: derive keys with the ACTUAL mobile
// code (../src/lib/crypto-derive.ts) and print them, to be diffed against the C
// ground truth (crypto_kd.c) over the same keys. stdin = one encryptionKey/line.
import { readFileSync } from "node:fs";
import { deriveKey } from "../src/lib/crypto-derive.ts";

const keys = readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
for (const k of keys) {
  process.stdout.write(Buffer.from(deriveKey(k)).toString("hex") + "\n");
}
