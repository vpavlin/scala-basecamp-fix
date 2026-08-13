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
- **Roles** are opt-in and default-open; **custom fields** are an optional per-calendar
  schema — a plain calendar looks exactly like a plain calendar, and a builder can grow
  something rich on the same log. (ADRs [0004](docs/adr/0004-roles-opt-in.md),
  [0005](docs/adr/0005-optional-field-schema.md).)
- **Signed events.** Each device holds a secp256k1 keypair (identity = its `0x` address);
  every event is signed and verified on merge, so roles are real authorization, not just
  attribution — a forged author folds away. Byte-parity C++ (OpenSSL) ↔ TS (@noble). The
  signer is a seam meant for a hardware backend (Keycard). (ADR
  [0007](docs/adr/0007-event-signing-identity.md).)

**→ [Design decisions (ADRs)](docs/adr/)** — the *why* behind all of the above, and the
`docs/archive/` folder holds the (retired) migration plans.

## Desktop architecture (Basecamp module, basecamp 0.2.0)

| Module | Type | Description |
|--------|------|-------------|
| `scala` | `core` (universal) | Core business logic — calendar/event CRUD, the fold, sync, sharing |
| `scala-ui` | `ui_qml` (universal) | QML frontend with a C++ backend that delegates to core via a typed replica |

Both modules use the [logos-module-builder 0.2.0](https://github.com/logos-co/logos-module-builder) universal authoring model:
- Auto-generated plugin wrappers from `*.impl.h` headers
- Typed inter-module SDK via `modules().dep.method()`
- Event subscriptions via `logos_events:` declarations
- No hand-written Qt plugins, no `Q_PLUGIN_METADATA`, no manual IPC wiring

The **mobile app** lives in [`mobile/`](mobile/) (Expo / React Native, arm64) and folds the
*same* event log with a byte-parity TypeScript mirror of the core (ADR [0006](docs/adr/0006-two-clients-one-fold.md)).

## Building

### Prerequisites
- Nix (2.4+) with flakes enabled
- GitHub access token for fetching flake inputs

### Build core module
```bash
nix build -L .#scala_module
# Output: result/bin/libscala_plugin.so
```

### Build UI module
```bash
cd scala-ui
nix build -L .#scala_ui_module
# Output: result/bin/libscala_ui_plugin.so
```

### Development (override local dependencies)
```bash
# Point scala-ui at your local scala checkout
cd scala-ui
nix flake update --override-input scala ../
nix build -L .#scala_ui_module
```

## Installing

Via lgpm (Logos Package Manager):
```bash
lgpm install ./result  # core module
cd scala-ui && lgpm install ./result  # UI module
```

Or manually:
```bash
mkdir -p ~/.local/share/logos/modules
cp result/bin/libscala_plugin.so ~/.local/share/logos/modules/
# Repeat for scala-ui
```

## Running

Launch basecamp 0.2.0 — Scala will auto-load as an available module.

For standalone testing:
```bash
nix run github:logos-co/logos-basecamp/0.2.0#app
```

## Project Structure

```
scala/
├── metadata.json          # Core module metadata (universal interface)
├── flake.nix              # Nix build config (mkLogosModule)
├── CMakeLists.txt         # LogosModule.cmake macro (~15 lines)
├── src/
│   ├── scala_impl.h       # Universal-pattern entry point (ScalaImpl : LogosModuleContext)
│   ├── scala_impl.cpp     # Implementation (calendar/event CRUD, sync, sharing)
│   ├── calendar_store.h/.cpp  # Local persistence layer
│   ├── calendar_sync.h/.cpp   # P2P sync via Logos Messaging
│   └── qr_generator.h/.cpp    # QR code generation (share links)
├── scala-ui/              # UI module (separate flake, ui_qml type)
│   ├── metadata.json      # UI module metadata
│   ├── flake.nix          # Nix build config (mkLogosQmlModule)
│   ├── CMakeLists.txt     # LogosModule.cmake + .rep reference
│   ├── src/
│   │   ├── scala_ui_backend.rep   # QML-visible interface definition
│   │   ├── scala_ui_backend.h/.cpp  # C++ backend (delegates to modules().scala.*)
│   └── qml/               # QML views (CalendarView, EventModal, etc.)
├── docs/
│   └── migration-plan-basecamp-0.2.0.md  # Migration documentation
└── legacy/                # Archived v0.1 files (Qt plugins, Makefile, etc.)
```

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| [kv_module](https://github.com/jimmy-claw/logos-kv-module) | Transitional fallback | Still in old format; 0.2.0 builder handles mixed graphs |
| messaging_module | Planned | For P2P calendar sync (not yet wired) |
| accounts_module | Planned | For identity management (not yet wired) |

## Status

**Working end-to-end, verified on real devices.** Desktop (Basecamp) ⇄ mobile ⇄ an
always-on headless hub sync peer-to-peer over Waku; cold-start and phone-was-off catch-up
both converge.

- ✅ Basecamp 0.2.0 module (core + `scala-ui`), packaged as `.lgx`
- ✅ Android app (`mobile/`), on the shared Logos Delivery ("Loam") node or embedded
- ✅ Event-log CRDT + byte-parity fold across C++ and TypeScript
- ✅ Sync on [logos-sync](https://github.com/vpavlin/logos-sync) recursive-RBSR catch-up
- ✅ Sharing via `scala://join` invite links (AES-256-GCM, key in the link)
- ✅ Calendar description, opt-in roles, optional custom-field schema, edit history

**Next:** consume logos-sync as a submodule (currently vendored); richer field rendering;
notifications; the `logos-*` → `loam-*` rename.

## Legacy (v0.1)

The v0.1 Qt-plugin code is archived in `legacy/`. Key changes from v0.1:
- Hand-written Qt plugins → auto-generated universal wrappers
- `QString`/`QJsonDocument` → `std::string`/standard C++
- Manual `LogosAPIClient` → typed `modules().dep.method()` SDK
- `module.yaml` + `Makefile` → `metadata.json` + Nix flake only

## License

MIT — see LICENSE file
