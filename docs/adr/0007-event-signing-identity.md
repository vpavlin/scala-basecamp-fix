# 7. Adopt loam-sync event signing (roles become enforcement)

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Roles (ADR [0004](0004-roles-opt-in.md)) were **attribution, not authorization**: an
event's author was an unauthenticated device id, so any key-holder could author an event
*claiming any author* — including the owner's — and the fold trusted it. (Tell: the UI
showed a `scala-default` placeholder; the identity had no cryptographic meaning.)

## Decision

Scala adopts the **loam-sync event-authenticity layer** — the generic contract (secp256k1
keypair; identity = `0x` address; sign the canonical envelope; verify on merge with
public keys only; a `Signer` seam the library injects so the private key can live in
software today and a **Keycard** tomorrow) is defined once in **logos-sync ADR
[0008](https://github.com/vpavlin/logos-sync/blob/main/docs/adr/0008-event-authenticity-signing.md)**
and is not restated here. This is the authenticity peer of ADR
[0006](0006-two-clients-one-fold.md)'s confidentiality (AES-GCM), and — like ADR
[0002](0002-adopt-logos-sync.md) — Scala consumes the spine rather than owning the design.

What is **scala-specific**:

- **Domain tag `scala-sig-v1`** in the canonical message.
- **The fold gates on `verified`** (`scala_engine.hpp` / `engine.ts`, byte-parity): a
  *present-but-invalid* signature is dropped (tamper); an *unsigned* legacy event is
  admitted but never counts as an authenticated author; in a **role-managed** calendar,
  `event.put/del/cal.meta` and `member.set` require an **authenticated** owner/admin, while
  an **open** calendar still admits anyone (signing gates roles, not writing).
- **Keys:** private key in SecureStore (mobile) / the core kv store (desktop); the author
  id / SDS senderId / `hlc.dev` all become the address. Keypair gen uses expo-crypto /
  OpenSSL RAND (never @noble's RNG).
- **Vendored today.** As with the rest of logos-sync, the implementation is currently
  vendored per-app (`src/scala_identity.hpp`, `mobile/src/lib/identity.ts`, kept
  byte-identical to qaku's so it hoists cleanly); consolidating it — with the `Signer`
  interface + `KeycardSigner` — into loam-sync is tracked with the submodule work.

## Migration

The author id changes from the old random `scala-*` id to a `0x…` address, so **calendars
created before 0.8.0 stay legacy/open** (old-style owner, unsigned events admitted,
attribution-only). Post-0.8.0 calendars get enforced signed roles. Unsigned `member.set`
from the pre-signing era folds away — a role-managed calendar reverts to open rather than
trusting an unauthenticated grant. Accepted clean cut (qaku did the same).

## Consequences

- A forged author claim folds away on every device; owner/admin is real write-authority.
- Any change to the canonical form, the address scheme, or the wire is guarded by the
  golden-vector cross-verify (C++/OpenSSL ↔ TS/@noble; note the `{ prehash: false }` pin —
  logos-sync ADR 0008). Verified end-to-end before shipping.
