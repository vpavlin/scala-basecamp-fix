// Mobile-side of the interop roundtrip: seal a plaintext with the REAL mobile
// crypto (fixed deriveKey + AES-256-GCM), then apply the mobile send framing
// (DOUBLE base64: b64(b64(sealed))). Prints:
//   line 1: encryptionKey
//   line 2: the double-b64 app payload the phone puts on the channel
// which the desktop transport peels once and hands to handleReceive. The C harness
// (interop_open.c) then proves the desktop opens it. Run from mobile/ so @noble resolves.
import { gcm } from "@noble/ciphers/aes.js";
import { deriveKey } from "../src/lib/crypto-derive.ts";

const KEY = process.argv[2] || "3190cb26-10e8-4dfa-a8f6-20decd5c0931f5bd9779-2e14-44c7-ae29-b9cd1cd2400d";
const PLAINTEXT = process.argv[3] || '{"v":1,"type":"EVENT","hello":"from the phone"}';

const key = deriveKey(KEY);
// Deterministic nonce for a reproducible test (real code uses a random 12-byte nonce).
const nonce = new Uint8Array(12).map((_, i) => (i * 37 + 11) & 0xff);
const ctAndTag = gcm(key, nonce).encrypt(new TextEncoder().encode(PLAINTEXT));
const tag = ctAndTag.slice(ctAndTag.length - 16);
const ct = ctAndTag.slice(0, ctAndTag.length - 16);
const sealed = new Uint8Array(12 + 16 + ct.length);
sealed.set(nonce, 0);
sealed.set(tag, 12);
sealed.set(ct, 28);

const b64 = (u) => Buffer.from(u).toString("base64");
const sealedB64 = b64(sealed);                       // layer 1
const doubled = b64(new TextEncoder().encode(sealedB64)); // layer 2 — the mobile app payload

process.stdout.write(KEY + "\n");
process.stdout.write(doubled + "\n");
process.stderr.write("plaintext: " + PLAINTEXT + "\n");
