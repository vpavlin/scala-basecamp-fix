# Keycard / delegation custody — implementation plan

> **⚠️ Historical / largely superseded (2026-08-18).** The delegation-cert spine this plan is built
> around did **not** ship. What actually landed: **mobile** Keycard = NFC tap-per-sign (the choppu
> stack, `mobile/src/lib/loam-keycard/`); **desktop** Keycard = `loam_core` delegating to Alisher's
> `keycard` module ([ADR 0016](adr/0016-desktop-keycard-authoring.md)); identity custody moved to Loam
> ([loam ADR 0004](https://github.com/vpavlin/loam/blob/master/docs/adr/0004-identity-as-a-loam-service.md)).
> Kept for history; see ADR 0016 for the current design.

Realizes scala ADR [0008](adr/0008-keycard-identity-custody.md), which adopts the shared contract
in [logos-sync ADR 0009](https://github.com/vpavlin/logos-sync/blob/main/docs/adr/0009-keycard-delegation-custody.md).
**The SDK lives in Loam, not scala:** the wire+verify spine is in `logos-sync`, the concrete NFC
signer in a new `loam-keycard` package; scala (pilot) and later qaku/kym/perun *consume* them.

## Phase 1 — the SDK spine in logos-sync ✅ done
- [x] `logos-sync/src/signing.ts`: `CustodyPolicy`, `DelegationCert`, `canonicalCert(domain)`,
      `verifyCert` (deterministic expiry on `hlc.wall`), `issueCert`/`issueCertAsync`,
      `AsyncSigner`, `signEventAsync`, and **cert-aware `verifyEvent`** (additive — cert-less
      wire unchanged). Exported from `src/index.ts`.
- [x] `logos-sync/test/delegation.test.mjs` — 15/15 (9 behaviour + 6 golden-parity). Existing
      signing parity test still green (no spine regression).
- [x] **Frozen delegation golden vector** in `logos-sync/test/golden/vectors.json` +
      `gen-delegation-vectors.mjs` — the byte-anchor the C++ core cross-verifies (ADR 0008 gate).
- [x] logos-sync ADR 0009 + scala ADR 0008 (consume) + this plan.

## Phase 1b — scala consumes the spine (no hardware, no wire change)
- [ ] Re-vendor logos-sync's cert-aware `verifyEvent`/`verifyCert` into scala's `identity.ts`
      (kept byte-identical to qaku's, ADR 0007) — cert-less path stays byte-for-byte identical.
- [ ] `calendar.ts mkEvent`: inject a `SoftwareSigner` from the SecureStore key; sign via the
      seam (default `tap-per-sign` → with a soft key that's just "sign", no card).
- [ ] Fold: add `scope` (calId ∈ cert.scope) + `maxSigs` (per-delegate count) enforcement to
      `engine.ts` **and** `scala_engine.hpp`, byte-parity, next to role gating.
- [ ] Mirror cert-aware verify into `scala_identity.hpp` (C++/OpenSSL) + a golden vector — owed
      only when certs first hit the wire (Phase 2), but land the code now.

## Phase 2 — loam-keycard (hardware) — GATED on a smoke test
- [ ] **Smoke test first** (turnkey checklist: `docs/keycard-smoke-test.md`): the `choppu` stack
      on a real NFC Android phone — pair/PIN/getKeys/`sign(32B hash)` round-trip, and the sig
      **verifies under `@noble`**. Go/no-go before any `loam-keycard` code.
- [ ] New **`loam-keycard`** package (native, sibling to loam-transport): a `KeycardSigner`
      implementing logos-sync's `AsyncSigner`; Expo config plugin (NFC perm, survives prebuild);
      pairing-blob + PIN session; card-removed / PIN-retry / block UX. Depends on logos-sync.
- [ ] `tap-per-sign`: on-card `sign(digest)` with the identity key, no cert.
      `delegated`/`exported`: `issueCertAsync` (one tap) → sign off-card with the delegate key.
- [ ] Settings UI: custody-policy picker (default `tap-per-sign`) + card status/enroll.

## Phase 3 — person-identity across devices + membership
- [ ] Desktop cross-enrollment: phone issues a bounded cert for the desktop's delegate pubkey
      over existing sync ("authorize this device") — no reader on desktop.
- [ ] Membership = set of card identity pubkeys (replaces the shared pairing-code); `member.set`
      grants keyed to identity address.
- [ ] (Optional) ECDH-wrap the AES-GCM room key to each member's card pubkey, retiring the code.

## Rollout
- [ ] After scala proves it, re-vendor into qaku / kym / perun (all already sign via the same
      logos-sync canonical form).
