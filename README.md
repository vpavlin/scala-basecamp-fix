# Scala — Secure CALendar App

A privacy-first, **local-first shared calendar** built on [Logos](https://logos.co) / Waku.
It runs on the **desktop** (a Basecamp module) and on **Android** (a React Native app),
and the two sync **peer-to-peer** — no server. Several people can edit a shared calendar
offline and converge with no write lost; it's end-to-end encrypted (the network only ever
moves sealed bytes).

**Scala** = **S**ecure **CAL**endar **A**pp

## How it works (the short version)

- **Event-log CRDT.** A calendar is an append-only log of immutable events; state is a pure
  fold over the merged log. Merge is union-by-id + HLC order → idempotent, commutative,
  convergent. (ADR [0001](docs/adr/0001-event-log-crdt.md).)
- **Shared sync engine.** The generic spine (envelope, HLC, merge, catch-up) is the shared
  [logos-sync](https://github.com/vpavlin/logos-sync) library; the byte transport is
  [logos-transport](https://github.com/vpavlin/logos-transport). Scala owns only its
  calendar fold, roles, schema, and crypto. (ADR [0002](docs/adr/0002-adopt-logos-sync.md).)
- **Catch-up.** A joining/returning device reconciles via recursive RBSR — it pulls the
  id-exact delta, not the whole log. (ADR [0003](docs/adr/0003-catch-up-recursive-rbsr.md).)
- **Roles & permissions — two rules.** Owner + **editors** may do anything and explicit
  **viewers** are read-only; everyone else may *add* events when the calendar is **Open**
  (a per-calendar toggle — a new calendar defaults **Closed**; opening it up is a deliberate
  choice) and may *edit/delete only the events they authored*.
  Enforced deterministically in the fold (not just the UI), so it converges. **Custom
  fields** are an optional per-calendar schema — a plain calendar looks exactly like a plain
  calendar, and a builder can grow something rich on the same log. (ADRs
  [0004](docs/adr/0004-roles-opt-in.md), [0005](docs/adr/0005-optional-field-schema.md).)
- **Signed events — always.** Every event is signed and verified on merge; an unsigned or
  forged-author event **folds away** — verification is unconditional (signatures are *not* an optional
  toggle), so roles are real authorization, not just attribution. Identity = a `0x` address derived
  from a secp256k1 pubkey; byte-parity C++ (OpenSSL) ↔ TS (@noble). (ADR
  [0007](docs/adr/0007-event-signing-identity.md).)
- **Identity is a Loam service.** Keys live in **`loam_core`** (desktop) / loam-transport (mobile) —
  never in scala. The app asks Loam to sign (`signDigest` / `keycardSign`) and stamps the returned
  `pub`/`sig`; it never holds a private key. Loam knows three kinds: the built-in **device** key,
  extra named **software** keys, and a **Keycard**. (loam [ADR
  0004](https://github.com/vpavlin/loam/blob/master/docs/adr/0004-identity-as-a-loam-service.md).)
- **Keycard (hardware) — phone *and* desktop, one card.** A Status Keycard *is* your identity — its
  key signs on-chip and never leaves. On mobile it's NFC tap-per-sign (the choppu stack, vendored at
  `mobile/src/lib/loam-keycard/`); on the desktop `loam_core` delegates to Alisher's `keycard`
  Basecamp module (`requestSign` over a PC/SC reader), with a "hold your Keycard" overlay in the view.
  Both sign at the **same** derivation path `m/43'/60'/1582'`, so **one physical card is one identity
  across phone + desktop**. (ADRs [0008](docs/adr/0008-keycard-identity-custody.md); desktop
  [0016](docs/adr/0016-desktop-keycard-authoring.md).)
- **Multiple identities, bound per calendar.** Bind each calendar to one identity (calendar→identity,
  event→calendar — like choosing which account owns an event in Google Calendar, one level up). Manage
  them in the drawer's *Identities* panel; pick "author as …" when creating or joining. Because events
  are self-describing (`pub`/`sig`/`dev`), this needs **no change to the fold or the wire**. Writing
  with an identity a calendar won't accept is **refused with a clear message**, never silently dropped.
  (ADR [0009](docs/adr/0009-per-calendar-identity.md).)

**→ [Design decisions (ADRs)](docs/adr/)** — the *why* behind all of the above. Retired
migration plans live in [`docs/archive/`](docs/archive/).

## Desktop architecture (Basecamp module, basecamp 0.2.0)

| Module | Type | Description |
|--------|------|-------------|
| `scala` | `core` (universal) | Core business logic — the event-log fold, calendar/event CRUD, sync, signing, sharing. Depends on **`loam_core`** — the Loam facade that owns transport (Waku + BLE bearers) **and** identity/signing (loam ADR 0004), so scala neither talks to `delivery_module` directly nor holds private keys. |
| `scala-ui` | `ui_qml` (universal) | **Pure-QML** frontend — the view calls the core directly with `logos.callModule("scala", …)`. There is **no** C++ backend/`.rep` replica; that redundant layer blocked the Basecamp load and was removed. Depends on `scala`. |

Both modules use the [logos-module-builder](https://github.com/logos-co/logos-module-builder)
universal authoring model:
- Auto-generated plugin wrappers from the `*_impl.h` header (no hand-written Qt plugins,
  no `Q_PLUGIN_METADATA`, no manual IPC wiring)
- Typed inter-module SDK via `modules().dep.method()` (core) / `logos.callModule` (QML view)
- Every public core method is auto-exposed to the view — no per-method glue

The **mobile app** lives in [`mobile/`](mobile/) (Expo / React Native, arm64) and folds the
*same* event log with a byte-parity TypeScript mirror of the core (ADR
[0006](docs/adr/0006-two-clients-one-fold.md)).

## Building

### Prerequisites
- Nix (2.4+) with flakes enabled
- GitHub access token for fetching flake inputs

### Build the core module (`.lgx`)
```bash
nix build -L .#lgx-portable
# Output: result/logos-scala-module-lib.lgx
```

### Build the UI module (`.lgx`)
```bash
cd scala-ui
nix build -L .#lgx-portable --override-input scala ..   # point the view at your local core
# Output: result/logos-scala_ui-module.lgx
```

> **Bump `metadata.json` `version` in each module BEFORE building** — the package repo keys
> on it, and a stale version installs the old bytes. Core and view version independently.

### Build the mobile app (arm64 APK)
```bash
cd mobile
npx expo prebuild --platform android      # re-applies the config plugins (not optional)
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# Output: mobile/android/app/build/outputs/apk/release/app-release.apk
```

## Publishing / installing

Artifacts are distributed through a self-hosted Basecamp package repo (the `.lgx` modules)
and a self-hosted F-Droid repo (the APK). Use the `logos-publish-artifacts` skill /
`publish.sh` to push the built artifacts and regenerate the signed indexes — a desktop's
package manager and the phone then see the new version. Basecamp auto-loads Scala once the
modules are in the repo it's configured against.

## Project structure

```
scala/
├── metadata.json              # Core module metadata (name, version, type:core, deps:[loam_core])
├── flake.nix                  # Nix build (mkLogosModule; targets: lgx / lgx-portable / lib / install)
├── CMakeLists.txt             # logos_module(...) — lists the compiled sources
├── src/
│   ├── scala_impl.h/.cpp      # Universal-pattern module entry; wires CRUD + sync + signing
│   ├── scala_engine.hpp       # THE fold (foldCalendar) — event-log CRDT, roles, permissions (header-only)
│   ├── scala_identity.hpp     # secp256k1 signing / verify — identity = 0x address (header-only, ADR 0007)
│   ├── logos_sync/            # Vendored logos-sync spine (envelope, HLC, merge, RBSR catch-up)
│   ├── logos_transport.hpp    # Transport shim over loam_core (which fronts delivery_module SDS + BLE)
│   ├── calendar_store.cpp     # Per-calendar event-log persistence
│   ├── calendar_sync.h/.cpp   # SYNC_REQ / RBSR reconcile wiring
│   ├── local_storage.h/.cpp   # KV persistence backend
│   ├── qr_generator.cpp + qrcodegen.*  # Invite-link QR encoding (vendored encoder)
│   └── types.h                # Shared C++ types
├── scala-ui/                  # UI module (separate flake, type:ui_qml, deps:[scala])
│   ├── metadata.json
│   ├── flake.nix              # mkLogosQmlModule
│   ├── qml/
│   │   ├── CalendarView.qml   # The whole view — month grid, event editor, settings/roles
│   │   └── Field.qml          # Generic custom-field widget (renders by schema type)
│   └── qml-harness/           # Offscreen render harness (mock logos.callModule) for UI tests
├── mobile/                    # Expo / React Native app (arm64) — TS mirror of the fold
│   └── src/lib/{engine,calendar,crypto,identity,scala-sync}.ts
├── docs/
│   ├── adr/                   # Architecture Decision Records (the why)
│   └── archive/               # Retired PLAN.md + migration plans
└── legacy/                    # Archived v0.1 Qt-plugin code
```

## Status

**Working end-to-end, verified on real devices.** Desktop (Basecamp) ⇄ mobile ⇄ an
always-on headless hub sync peer-to-peer over Waku; cold-start and phone-was-off catch-up
both converge.

- ✅ Basecamp 0.2.0 modules (core + pure-QML `scala-ui`), packaged as `.lgx`
- ✅ Android app (`mobile/`), on the shared Logos Delivery ("Loam") node or embedded
- ✅ Event-log CRDT + byte-parity fold across C++ and TypeScript
- ✅ Sync on [logos-sync](https://github.com/vpavlin/logos-sync) recursive-RBSR catch-up
- ✅ Sharing via `scala://join` invite links (AES-256-GCM, key in the link)
- ✅ **Always-signed events** — verification is unconditional; unsigned writes fold away (ADR 0007)
- ✅ **Identity is a Loam service** — device / named-software / Keycard kinds, bound per calendar,
  "author as …" on create/join; keys never leave Loam (loam ADR 0004, scala ADR 0009)
- ✅ **Keycard on mobile** — NFC tap-per-sign, key never leaves the card (ADR 0008)
- ✅ Two-rule permissions (owner/editor/viewer + Open toggle + edit-your-own), with a
  read-only **"why"** explanation (ADR 0013); calendars **default Closed**
- ✅ **Agenda view + search** across calendars (ADR 0011); month grid; date/time pickers with
  **Local vs UTC** time entry (ADR 0012)
- ✅ **Per-calendar sync-status chips** (ADR 0014); calendar description; optional custom-field
  schema; **full-form calendar create** (name/desc/schema/open in one step, ADR 0015); edit history
- 🟡 **Keycard on desktop** — `loam_core` delegates on-card signing to the `keycard` module
  (compile- + render-verified; **on-card verification pending a reader**) (ADR 0016)

**Next:** on-card desktop-Keycard verification (enrolled address == the phone's card); consume
logos-sync as a submodule (currently vendored); richer field rendering; Basecamp system
notifications; a desktop search box + UTC toggle; finish the `logos-*` → `loam-*` rename.

## Legacy (v0.1)

The v0.1 Qt-plugin code is archived in `legacy/`. Key changes from v0.1:
- Hand-written Qt plugins → auto-generated universal wrappers
- `QString`/`QJsonDocument` → `std::string`/standard C++
- Manual `LogosAPIClient` → typed `modules().dep.method()` SDK / `logos.callModule`
- `module.yaml` + `Makefile` → `metadata.json` + Nix flake only

## License

MIT — see LICENSE file
