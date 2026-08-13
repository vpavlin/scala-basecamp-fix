# 2. Adopt logos-sync (extract the sync spine)

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Scala's event envelope, HLC, and `mergeEvents` were hand-written — and byte-identical to
KYM's and qaku's. Four apps carrying four copies of the same sync core is exactly how they
*diverged*: scala ended up re-broadcasting its whole log while KYM already had efficient
reconciliation, purely because the reasoning didn't travel with the code.

## Decision

Extract the generic sync spine into **[logos-sync](https://github.com/vpavlin/logos-sync)**
(event envelope + HLC + `mergeEvents` + reconciliation + the catch-up protocol) and make
**scala its first consumer**. `scala_engine.hpp` now `#include`s the vendored headers and
**aliases** the shared spine into `scala::` (they were identical, so this was pure
de-duplication); the mobile app imports the TS mirror. What stays scala's: the `ET::`
event types, `foldCalendar`, roles, and the field schema.

The boundary (logos-sync ADR 0006/0007): **logos-transport moves bytes · logos-sync
decides which bytes · scala owns the schema, the fold, and the crypto.** logos-sync never
sees a key or a socket.

## Consequences

- A sync fix flows to scala (and later qaku/kym/perun) via a library bump, not a manual
  re-vendor. Cross-language parity is guarded by logos-sync's golden vectors.
- Today the headers are **vendored** under `src/logos_sync/` and `mobile/src/lib/`; the
  next step is consuming logos-sync as a git submodule (tracked separately).
