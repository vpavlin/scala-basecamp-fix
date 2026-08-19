# Keycard `choppu`-stack smoke test (Phase 2 gate)

> **✅ Gate cleared (historical).** This was the go/no-go before writing any Keycard code. The choppu
> stack works and mobile Keycard shipped, so the gate is passed — this doc is kept as a record.

The **one unknown** blocking `loam-keycard`: the official `react-native-status-keycard` is
archived (Apr 2026), so we'd build on the community **`choppu`** stack
(`react-native-keycard` 1.0.4 + `keycard-sdk` 3.1.x/4.0). Prove it end-to-end on real hardware
**before** writing any `loam-keycard` code.

## Fastest test: run the maintainer's example app (no custom code)
`choppu/react-native-keycard` ships a full example (wallet / pair / PIN / sign). There is **no
prebuilt APK** — build it (native dev build, RN New Architecture, **not** Expo Go):
```bash
git clone https://github.com/choppu/react-native-keycard.git
cd react-native-keycard/example && yarn install
# phone via USB, USB-debugging + NFC on:
yarn android      # (yarn start in a 2nd terminal if Metro doesn't auto-start)
```
Phone: Wallet tab → Create/Load mnemonic → tap card → **Sign**. Round-trips → gate cleared.
Prereqs: Node ≥ 20, Yarn, Android Studio + SDK, API 21+, the card PIN (3 wrong → blocked).

## What we must prove (go/no-go)
1. NFC detects the card on a modern Android phone (API 33+).
2. We can **pair** and open a secure channel with a PIN.
3. We can read the **public key** (`getKeys`).
4. We can **sign an arbitrary 32-byte hash** and the signature **verifies** against that public
   key with `@noble/curves` (the exact stack logos-sync uses).

If all four pass → build `loam-keycard`'s `KeycardSigner` (implements logos-sync `AsyncSigner`:
`publicKey()` from step 3, `signDigest(d)` = step 4). If step 4's sig doesn't verify under
`@noble`, the whole delegation-cert chain won't — stop and dig before proceeding.

## Prerequisites
- A provisioned Keycard (has a keypair; if blank, `generateAndLoadKey` first) + its PIN.
- An NFC Android phone (not an emulator — NFC is physical), a **dev build** (not Expo Go).
- A spare Expo/RN app to host the test (don't touch scala/loam yet).

## Setup
1. `npm i choppu/react-native-keycard keycard-sdk` (confirm exact package names/versions from the
   repo — the research was summary-level; check `choppu/react-native-keycard` README + its
   `app.plugin.ts` example).
2. Add the Expo **config plugin** (NFC permission via `withAndroidManifest`; the choppu repo
   ships an `app.plugin.ts` to copy). `minSdkVersion >= 23`.
3. `npx expo prebuild` → `npx expo run:android` on the device.

## The real API (for `loam-keycard`, once the example proves the hardware)
The choppu API is NOT per-step `pair()/verifyPin()/sign()`. It's one orchestrator that runs
init/pair/secure-channel/PIN for you, then hands a low-level `Commandset` to your callback:

```ts
import { KeycardManager } from "keycard-sdk";
import { RecoverableSignature } from "keycard-sdk/dist/recoverable-signature";
import RNKeycard from "react-native-keycard";           // RNKeycard.NFCCardChannel, .PairingStorage

const km = new KeycardManager(RNKeycard.PairingStorage);
await RNKeycard.startNFC("Hold your card…");             // tap + hold through the whole exchange
const chan = new RNKeycard.NFCCardChannel();
const res = await km.runOnSecureChannel(chan, /*state LOADED*/ 1, { pin, pairingPassword }, async (cmdSet) => {
  const digest = /* our 32-byte event/cert digest — NOT re-hashed on card */;
  const tlv = (await cmdSet.signWithPath(digest, "m/…", false)).checkOK().data;   // BER-TLV
  const sig = new RecoverableSignature({ hash: digest, tlvData: tlv });           // → r, s, publicKey
  return { r: sig.r, s: sig.s, pub: sig.publicKey };
});
await RNKeycard.stopNFC();
```

**Go/no-go for the smoke test** (the example app already does all this — just watch it succeed):
NFC fires, pair/PIN succeed, a Sign returns a signature, and it verifies against the card's key.

## What `loam-keycard`'s `AsyncSigner` must adapt (confirmed from the SDK source)
- **Signature is BER-TLV, not DER/compact.** Parse with `RecoverableSignature`; `r`/`s` are
  minimal-length big-endian (may be <32 bytes) → **left-pad each to 32** to build the 64-byte
  `r‖s` compact that logos-sync/`@noble` expects.
- **Normalize to low-S.** The applet may return high-S; logos-sync's verify (and OpenSSL) want
  canonical low-S — flip `s = n - s` if `s > n/2` before handing over the 64-byte sig.
- **Compress the pubkey.** The card/SDK give **uncompressed 65-byte `0x04…`**; logos-sync's
  `address()`/`AsyncSigner.publicKey()` need **33-byte compressed** (`CryptoUtils.compressPublicKey`).
- **Signs the raw 32-byte digest, no re-hash** ✅ — matches logos-sync (`@noble` v1, no prehash).
  Pass the event/cert digest straight in.
- **Pairing:** Secure Channel **V2 (appVersion ≥ 0x0400) uses no pairing slots**; the classic
  5-slot limit only bites V1 cards. `PairingStorage` (MMKV + nitro-modules) persists it per card.
- **PIN retries:** 3 wrong → PIN blocks (PUK to recover). NFC must stay in range for the whole
  multi-APDU exchange.

## After green
Create `loam-keycard` (sibling to loam-transport, own repo, depends on logos-sync). Its
`KeycardSigner.signDigest` = steps 1-4 wrapped; `tap-per-sign` signs the event digest directly,
`delegated` calls `issueCertAsync` once then signs off-card with an ephemeral key. Then wire
scala per `keycard-plan.md` Phase 1b/2.
