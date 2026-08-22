// ADR-0011 nonce parity: reproduce the MOBILE deterministic seal inline with the
// same @noble libs the app uses, for a fixed key+sealId+plaintext, and print the
// derived nonce + full sealed bytes as hex. The C++ harness prints the same for the
// same vector; they MUST be byte-identical (desktop<->mobile parity). Run from mobile/.
import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { deriveKey } from "../src/lib/crypto-derive.ts";

const enc = new TextEncoder();
const hex = (u) => Buffer.from(u).toString("hex");

const KEY = "3190cb26-10e8-4dfa-a8f6-20decd5c0931f5bd9779-2e14-44c7-ae29-b9cd1cd2400d";
const PT = '{"v":1,"id":"11111111-2222-4333-8444-555555555555","type":"EVENT"}';
const SEAL_ID = "11111111-2222-4333-8444-555555555555";

const key = deriveKey(KEY);
// nonceFor — must match crypto.ts exactly.
const nonce = hmac(sha256, key, enc.encode(`scala/nonce/v1|${SEAL_ID}`)).slice(0, 12);

// seal — same body as crypto.ts (nonce||tag||ciphertext).
const ctAndTag = gcm(key, nonce).encrypt(enc.encode(PT));
const tag = ctAndTag.slice(ctAndTag.length - 16);
const ct = ctAndTag.slice(0, ctAndTag.length - 16);
const sealed = new Uint8Array(12 + 16 + ct.length);
sealed.set(nonce, 0);
sealed.set(tag, 12);
sealed.set(ct, 28);

console.log("nonce(idA) =", hex(nonce));
console.log("seal(idA)  =", hex(sealed));
