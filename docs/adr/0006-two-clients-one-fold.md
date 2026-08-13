# 6. Two clients, one fold (C++ ↔ TS parity) + AES-GCM crypto

- **Status:** accepted
- **Date:** 2026-07 → 2026-08

## Context

Scala ships a **desktop Basecamp module** (C++ core + QML view) and a **React Native
mobile app**. They must fold the same log to the same state and speak the same wire — a
divergence looks exactly like "the network is down."

## Decision

- **One fold, mirrored in two languages.** `scala_engine.hpp` (C++) and
  `mobile/src/lib/engine.ts` (TS) implement the same `foldCalendar`, event types, merge and
  roles — kept byte-parity (the generic parts now come from logos-sync's parity-tested
  spine; the calendar fold is mirrored by hand and tested with matching scenarios). The
  desktop `std::map`-by-id ordering is matched by a sort on the mobile side.
- **App-level AEAD is AES-256-GCM** (`nonce ‖ tag ‖ ciphertext`, no AAD) — *scala's* choice,
  distinct from the ChaCha20-Poly1305 the other apps use, which is exactly why crypto stays
  app-side (logos-sync ADR 0006). The per-room key is two concatenated dashed UUIDv4s; the
  desktop derives the 32-byte key via `sscanf("%2hhx")` which **stops at the dashes** and
  reads a byte as *signed* — a deterministic-but-"wrong" parse the phone must reproduce
  exactly (`crypto-derive.ts`), gated by a golden-vector test, or every message fails to
  authenticate.
- **Invite links** (`scala://join?id=…&key=…&name=…`) are built/parsed byte-identically on
  both sides.

## Consequences

- A calendar edited on the phone and the desktop converges; sync verified end-to-end on a
  real device.
- Any change to the fold, the crypto, or the wire is a two-file change with a parity test
  as the definition of done.
