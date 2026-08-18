# 8. Adopt Keycard delegation custody (from logos-sync)

- **Status:** accepted
- **Date:** 2026-08-17

## Context

ADR [0007](0007-event-signing-identity.md) made authorship a real secp256k1 signature behind a
`Signer` seam and reserved the Keycard case for later. vpavlin's steer: put a **Keycard** behind
that seam, let the **user choose how often to tap** (defaulting to more security), and — as with
sync itself (ADR [0002](0002-adopt-logos-sync.md)) — **the SDK lives in the shared Loam library,
not in scala.** Scala consumes it.

## Decision

The generic **delegation-custody contract** — the `CustodyPolicy` slider (`tap-per-sign` /
`delegated` / `exported`), the `DelegationCert`, the on-card cert issuance, and the cert-aware
`verifyEvent` — is defined **once in [logos-sync ADR 0009](https://github.com/vpavlin/logos-sync/blob/main/docs/adr/0009-keycard-delegation-custody.md)**
and implemented in `logos-sync/src/signing.ts` (byte-parity spine). The concrete NFC signer
(react-native-keycard / the `choppu` stack) lives in a separate **`loam-keycard`** package so
the sync lib keeps zero native deps. Scala restates none of that.

What is **scala-specific**:

- **Domain tag `scala-deleg-v1`** in the canonical cert (peer of `scala-sig-v1`, ADR 0007).
- **Default custody = `tap-per-sign`** — calendar edits are infrequent, so hardware-bound
  authorship per event is acceptable and is the secure default vpavlin asked for.
- **Fold enforcement of `scope` + `maxSigs`.** logos-sync's `verifyCert` covers signature +
  expiry (deterministic on the event's `hlc.wall`); the *count* (`maxSigs`) and *container*
  (`scope` = calId) checks are the fold's job — added to `engine.ts` **and** `scala_engine.hpp`
  byte-parity, alongside the existing role gating (ADR [0004](0004-roles-opt-in.md)). A
  privileged claim under a cert counts only when the cert is valid, in-scope, and under budget.
- **Consumes, doesn't vendor logic:** scala's `identity.ts` / `scala_identity.hpp` adopt
  logos-sync's cert-aware `verifyEvent` + `verifyCert` (kept byte-identical to qaku's, per ADR
  0007), and the app injects a `SoftwareSigner` today / a `loam-keycard` `AsyncSigner` tomorrow.

## Migration

Cert-less events verify exactly as today, so **adopting the layer changes nothing on the wire**
until scala actually emits certs (the first Keycard build). Pre-Keycard calendars are
unaffected; enabling a card only changes how *new* events are authored, not the fold's contract.

## Consequences

- Security/convenience is the user's choice; the safe end is the default.
- The card's root key never leaves except the explicit `exported` opt-out.
- Desktop needs no reader after enrollment (a phone issues its delegate cert over sync).
- Wire/cert canonical changes are guarded by the same golden-vector C++↔TS cross-verify as ADR
  0007 — owed when certs first ship.
- **Gate:** the `loam-keycard` NFC signer builds on the `choppu` stack (the official RN Keycard
  lib is archived); a real-phone smoke test precedes any Keycard code (see `docs/keycard-plan.md`).
