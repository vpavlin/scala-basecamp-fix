# 16. Desktop Keycard authoring — the concrete integration

- **Status:** proposed (design complete; view UX prototyped + render-verified with a mocked keycard
  module; on-card path unbuilt — needs the card + a PC/SC reader + Alisher's keycard LGX)
- **Date:** 2026-08-18

## Context

[ADR 0010](0010-keycard-on-basecamp.md) chose the desktop Keycard path: consume Alisher's native
`keycard` Basecamp module (`keycard-qt` over PC/SC) via `logos.callModule("keycard","requestSign",…)`
— on-card signing, key never leaves. This ADR pins the **concrete mechanism**, because the desktop
signs differently from mobile: the scala **core signs in C++** (`scala_identity.hpp`:
`canonicalMessage → sha256 → ecdsaSignLowS(priv, digest)`), while `requestSign` is a **QML**
(`logos.callModule`) call the **view** makes. So a card signature has to cross the core↔view boundary.

Facts that shape the design (verified against source):
- Core method surface (`calendar_module.cpp`, Q_INVOKABLE): `getIdentity`, `createCalendar`,
  `createEvent(calId, eventJson)`, `updateEvent(eventJson)`, … — each **builds + signs + publishes**
  in one call today.
- `scala_identity.hpp` has `canonicalMessage`, `ecdsaSignLowS`, `verifyEvent(pub33, sig, digest)`,
  `identityFromPriv` — but **no ECDSA public-key recovery** from a recoverable signature yet.
- `dev` (the author address) is part of `canonicalMessage`, so it must be known **before** the digest
  is computed — but the card's address is only known **after** we have its pubkey. Chicken-and-egg.
- Alisher's `requestSign({domain, payloadHash, caller, scheme})` signs at a **domain-derived
  non-exportable path** `m/43'/60'/1582'/…`; scala's `domainToSignPath("scala")` (loam-keycard
  `paths.ts`, byte-identical to his `plugin.cpp`) is the same key mobile uses — one card, one identity.

## Decision

**Enrol once, then sign per event** — mirror mobile's model, split across core + view.

### 1. Enrol (one card tap) — resolve the chicken-and-egg
The card's `domainToSignPath("scala")` key is stable, so fetch its **address/pubkey once** and cache
it on the desktop (like mobile's SecureStore enrolment):
- View calls `requestSign({domain:"scala", payloadHash: sha256("scala-keycard-enroll-v1"), scheme:"ecdsa"})`.
- The result is a **recoverable** ECDSA sig (`R‖S‖V`); the **core recovers** the pubkey from
  `(digest, r, s, V)` — a new `ecdsaRecover()` in `scala_identity.hpp` (OpenSSL
  `ECDSA_SIG` + `EC_POINT` from recovery id), compress to 33B, `address = "0x"+sha256(pub)[24:64]`
  (the existing `addressFor`). Cache `{cardAddress, cardPubHex}`.
- (Alternative: if the `keycard` module exposes a `getPublicKey(domain)`, use it and skip recovery.
  Recovery is the no-extra-API path and reuses primitives we already have.)

### 2. Per-event sign — core builds unsigned, view gets it card-signed, core attaches
Add a **keycard authoring mode** to the core (selected when the calendar's identity is the enrolled
card). Two new Q_INVOKABLE methods make the boundary crossing explicit and keep all crypto in C++:
- **`beginKeycardEvent(type, calId, payloadJson) → {eventJson, digestHex}`** — build the event with
  `dev = cardAddress` (cached), stamp HLC, compute `canonicalMessage → sha256`, return it **unsigned**
  + the hex digest. Nothing is published yet.
- View: `requestSign({domain:"scala", payloadHash: digestHex, caller:"scala", scheme:"ecdsa"})` →
  poll `checkSignStatus` → `{signature}` (64B `r‖s`, low-S — normalise if needed).
- **`attachAndPublishKeycardEvent(eventJson, sigHex) → ok`** — set `e.pub = cardPubHex`,
  `e.sig = sigHex`, `verifyEvent` locally (reject a bad sig), then append + publish through the
  normal path.

The view drives the UX between the two calls: a "hold your Keycard" overlay while polling, a friendly
error on `rejected`/timeout (Alisher's poller leaves wrong-PIN/lockout at `pending` — the view needs
its own timeout), and a retry.

### 3. Card use is per-calendar OPT-IN; no dependency declaration
Alisher's guide says to add `"dependencies": ["keycard"]`, but that's wrong for scala:
- **Basecamp's manifest `dependencies` is a hard, all-must-be-present list** — there is no
  optional/soft-dependency concept. Declaring `keycard` would make Basecamp refuse to load `scala_ui`
  for every user who doesn't have the keycard module + a reader — breaking the app for almost everyone.
  So **do NOT declare it** (keep `["scala"]`).
- **A module being installed does not mean the user wants scala to use the card.** Someone may have
  keycard installed for another app. So detection is NOT the gate. The gate is **explicit user
  intent**: a calendar is bound to "sign with Keycard" (the desktop analogue of mobile's per-calendar
  keycard identity, [ADR 0009](0009-per-calendar-identity.md)). Only a keycard-bound calendar ever
  calls the module.
- **Graceful absence for an opted-in calendar.** `KeycardSign.qml` wraps every
  `logos.callModule("keycard",…)` in try/catch (`_call`), so if the user turned on Keycard signing
  but the module/reader is absent, the write fails with a clear message ("Keycard signing is on for
  this calendar, but the keycard module isn't installed / no reader") — never a crash. Detection is
  only for that message, never a UI gate.

### 4. No fold / wire change
A card-signed event is a normal signed event (`pub`/`sig`/`dev`) — it verifies identically to a
software-signed one on every peer, and **signatures-required** ([ADR 0015](0015-full-form-calendar-create.md))
accepts it and drops unsigned writes. No cert, no cert-aware verify (that was the *no-reader* fallback
in ADR 0010; with a reader we sign directly).

## Consequences

- **One card = one identity across phone + desktop** — same `domainToSignPath("scala")` key; a
  card-owned calendar authored on the phone is editable on Basecamp with the same card, and vice versa.
- **All crypto stays in the core** (recovery, digest, verify); the view only shuttles the digest out
  and the signature back — so the trust surface isn't spread into QML.
- **New core surface** (needs a core build): `ecdsaRecover`, `beginKeycardEvent`,
  `attachAndPublishKeycardEvent`, an enrol/cache path, and a per-calendar "sign with keycard" flag.
  Desktop stays otherwise single-identity ([ADR 0013](0013-permission-transparency.md)).
- **Dependencies:** a USB PC/SC contactless reader + Alisher's `keycard-core.lgx`/`keycard-ui.lgx`
  installed; his module is pre-release/experimental — the `requestSign` contract is coded-to-doc, not
  yet confirmed live.

## What is prepped now (card-free) vs. needs the card

**Done + render-verified (mocked keycard module in `qml-harness`):** the view-side `requestSign` +
poll + tap-overlay + reject/timeout flow, and the `logos.callModule("keycard",…)` contract usage.

**Needs the card (+ reader + keycard LGX) — the on-card test checklist:**
1. Enrol: `requestSign` the enrol digest → core `ecdsaRecover` → assert the recovered **address equals
   the mobile Keycard address** for `domainToSignPath("scala")` (the whole point).
2. Author an event via `beginKeycardEvent` → `requestSign` → `attachAndPublishKeycardEvent`; assert
   `verifyEvent` passes locally.
3. Confirm the card-signed desktop event **syncs to the phone** and verifies there.
4. Turn on **signatures-required** for that calendar; confirm an unsigned write is dropped and the
   card-signed one survives, on both clients.
5. Poller: pull the card mid-sign / enter a wrong PIN → the view times out with a clear error, not a
   hang.
