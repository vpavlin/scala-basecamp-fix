# 10. Keycard on Basecamp — consume Alisher's native `keycard` module

- **Status:** proposed (integration sketch; not yet built — needs a PC/SC reader + the keycard LGX)
- **Date:** 2026-08-18

## Context

scala mobile signs events on a Status Keycard over NFC ([ADR 0008](0008-keycard-identity-custody.md)).
The desktop (Basecamp) has no NFC radio, so we couldn't tap the card there. ADR 0008's fallback was
a **delegation certificate** (phone issues a card-signed cert for a desktop delegate key), which
needs a new cert-aware verify in the C++ fold.

**A better option now exists.** [xAlisher/keycard-qt](https://github.com/xAlisher/keycard-qt) is a
native C++/Qt Keycard driver (a 1:1 keycard-go replacement) with a **PC/SC backend for desktop**
(Linux/mac/Win) and a Qt-NFC backend for mobile. [xAlisher/keycard-basecamp](https://github.com/xAlisher/keycard-basecamp)
wraps it as a Basecamp `keycard` module — **keycard-core** (C++ + keycard-qt, on-card BIP32,
encrypted pairing storage) + **keycard-ui** (PIN approve/decline panel) — and exposes a consumer
IPC. With a cheap USB contactless reader, Basecamp can sign **on-card, key-never-leaves**, and we
need **no delegation cert and no C++ cert-verify change** for that path.

## The `keycard` module API (what we consume)

`logos.callModule("keycard", …)`, poll-based. Two operations:

- **`requestSign({domain, payloadHash, caller, scheme})` → poll `checkSignStatus(signId)`** —
  the card signs `payloadHash` (a hex 32-byte digest) **directly, on-card**, at a non-exportable
  path. `scheme: "ecdsa"` (ours) or `"schnorr"` (BIP340, LEZ). Returns `{status:"complete",
  signature, scheme}`. **This is scala's path.**
- `requestAuth(domain, caller)` / `deriveKey` → poll `checkAuthStatus` — returns a 32-byte
  EIP-1581-**exportable** key (for encryption/vaults). Not what scala wants.

Poller contract: statuses are only `pending` / `complete` / `rejected` (+ `{error:"…not found"}`).
**Wrong PIN and PIN-lockout stay `pending`** — the consumer needs its own timeout; there is no
`failed`.

## The identity-alignment key fact

The keycard module derives its signing key from the **domain string**:

```
idx = SHA256("logos-" + domain) → first 16 bytes as four big-endian uint32, each & 0x7FFFFFFF
sign path (non-exportable):  m/43'/60'/1582'/idx0'/idx1'/idx2'/idx3'
```

For **one physical card to be one identity across phone and desktop**, both must sign at the same
path. scala mobile therefore signs at **`domainToSignPath("scala")`** (loam-keycard `paths.ts`,
byte-for-byte identical to keycard-core's `domainToIndices`/`domainToSignPath`) — set via
`createKeycardSession({ signingDomain: "scala" })`. Then the card yields the **same key** whether
tapped on the phone (`signWithPath(digest, path)`) or driven on Basecamp
(`requestSign({domain:"scala"})`), so `addressForPub(pub)` is the same on both → a card-owned
calendar is writable from either. (This change moved the mobile address; see the re-enrol note.)

## Decision — Basecamp authoring flow

scala's Basecamp core already builds and signs events (the `logos_sync` signer seam). For a
card-bound calendar, route the signature through the keycard module instead of the software signer:

1. **manifest:** add `"dependencies": ["keycard"]`; user installs `keycard-core.lgx` +
   `keycard-ui.lgx` and has a PC/SC reader + the card.
2. **build the unsigned event** in the core as today; compute the **canonical digest**
   `d = sha256(canonicalMessage(ev))` — the *exact* bytes the fold verifies (identity.ts /
   `scala_identity`), so mobile, desktop, and the fold all agree.
3. **request the signature** (the QML/view layer, where `logos.callModule` lives):

   ```qml
   function signOnCard(hexDigest, onDone, onFail) {
     var r = JSON.parse(logos.callModule("keycard", "requestSign", [JSON.stringify({
       domain: "scala", payloadHash: hexDigest, caller: "scala", scheme: "ecdsa" })]));
     if (!r.signId) { onFail(r.error || "no signId"); return }
     poll(r.signId, onDone, onFail)   // checkSignStatus every ~800ms, with a timeout (lockout stays 'pending')
   }
   ```
4. **map the result onto the event.** ECDSA `signature` is recoverable `R‖S‖V` (65B). Take
   `r‖s` (64B, low-S normalized) → `ev.sig`; **recover** the public key from `(digest, r, s, V)`,
   compress to 33B → `ev.pub`; assert `addressForPub(pub) === calendar.owner` (the card is the
   owner). No extra call needed. (If a future module build returns a bare 64B sig, add a
   `getPublicKey(domain)` call instead of recovering.)
5. **attach + publish** `ev.pub`/`ev.sig` via the normal core path. Peers (mobile + desktop) verify
   it like any signed event — **no wire/fold change**. A **signatures-required** calendar
   ([ADR 0009](0009-per-calendar-identity.md) follow-up) accepts it and drops anything unsigned.

### Core ↔ view seam
`logos.callModule` is a QML API; the NFC/PC/SC work is in the keycard module, not scala's core. So
the card signature is fetched in scala's **view** and handed back to the core to attach. Concretely:
the core exposes "author this event with an externally-supplied signature" (emit unsigned event +
digest → view signs via keycard → core attaches + publishes), mirroring how the mobile signer is a
per-call seam. If Basecamp later allows core-to-core module IPC, the core can call `keycard`
directly and the view only drives the approval UI.

## Consequences

- **Desktop card signing with a reader needs no cert and no C++ verify change** — the event is
  directly signed and verifies identically to a phone-signed one.
- **One card = one identity across phone + desktop**, courtesy of the shared `domainToSignPath`.
- **Re-enrol required (mobile):** the signing path changed (`m/44'/60'/0'/0` → `m/43'/60'/1582'/…`),
  so the derived address changed. Old card-owned calendars are orphaned; users re-enrol the card and
  rebind. (loam-keycard bumped scala's storage prefix to force a clean re-enrol.)
- **Delegation cert (ADR 0008) is still the answer for a desktop with _no_ reader** — the two are
  complementary: reader present → `requestSign`; no reader → phone-issued delegation.
- **Dependencies / caveats:** a USB PC/SC contactless reader; `keycard-basecamp` is experimental,
  pre-release-Basecamp, unaudited; the poller must time out (lockout/wrong-PIN stay `pending`);
  `payloadHash` must be scala's canonical digest byte-for-byte or the signature won't verify.

## Status / next steps

Not built (no reader in-hand; the keycard LGX is dev-only). When a reader is available: (1) add the
manifest dep + install the LGX; (2) implement the view-side `signOnCard` + poller; (3) add the
core "attach external signature" hook; (4) recover pub from the recoverable sig and assert the
owner address; (5) test a card calendar authored on the phone → edited on Basecamp (same identity).
