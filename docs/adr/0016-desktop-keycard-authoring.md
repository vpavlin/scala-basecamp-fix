# 16. Desktop Keycard authoring — the concrete integration

- **Status:** loam_core delegation **+ scala async authoring** implemented, compile- and
  render-verified (2026-08-18). Remaining: on-card verification only (needs the card + a PC/SC
  reader + Alisher's keycard + keycard-ui LGX installed).
- **Date:** 2026-08-18

## Update (2026-08-18): keycard now lives in loam_core — and the "BLOCKER" was wrong

Identity is a **loam_core service** ([loam ADR 0004](https://github.com/vpavlin/loam/blob/master/docs/adr/0004-identity-as-a-loam-service.md)),
so keycard on the desktop belongs in **loam_core**, delegating to Alisher's keycard module — NOT in
scala's core. scala stays keycard-agnostic (it consumes loam_core's identity list + labels; the
`KeycardSign.qml` prototype was deleted and the keycard copy genericised).

**RETRACTION of the earlier "BLOCKER".** A previous draft claimed loam_core *could not* reach the
keycard module because the universal `LogosModuleContext` exposes only `modules()` for declared
dependencies and has no raw `callModule`. That reasoning was wrong. The fix is the ordinary one:
**declare `keycard` as a dependency** — exactly like `delivery_module` — and the module-builder
generates a typed caller. Verified by building `loam_core` with `"dependencies": [… "keycard"]`:
the codegen produced `keycard_api.h` (a full `Keycard` class with `requestSignAsync`,
`checkSignStatusAsync`, `deriveKeyAsync`, `authorizeAsync`, … — every method in sync **and** async
form, `std::string`-normalised from keycard's Qt `Q_INVOKABLE QString` surface). loam_core's impl
then compiles calling `modules().keycard.requestSignAsync(...)`. There was never an SDK gap.

**The real trade-off (decided): coupling.** Basecamp dependencies are load-time-mandatory (no
optional deps), so declaring `keycard` makes it a **hard dependency of loam_core** — every app on
loam_core (kym, qaku, perun) now requires the keycard module (+ its `pcsclite`/`keycard-qt`/
`libsodium` runtime) installed to load, even with no reader. The keycard module loads idle without a
card. **Decision (2026-08-18): keep it in loam_core** — identity is uniformly a loam service; the
idle install is acceptable, especially for the LAN-repo deployment.

## The contract (source-verified against xAlisher/keycard-basecamp master)

Two derivation subtrees, both keyed by the SAME indices `SHA256("logos-"+domain)[0:16]` as four
hardened BIP32 indices (byte-identical to mobile loam-keycard `paths.ts`):
- `domainToPath`  = **`m/43'/60'/1581'/…`** — *exportable*; used by `requestAuth`/`deriveKey`, which
  hand back the raw 32-byte private key. **Do NOT use this for identity signing** — it is a
  *different key/address* than the phone signs with, so it would break cross-platform identity.
- `domainToSignPath` = **`m/43'/60'/1582'/…`** — *non-exportable*, on-card signing; used by
  `requestSign`. **This is byte-identical to mobile's `domainToSignPath`**, so a card signs the same
  identity on desktop and phone. This is the path we use.

On-card signing API (the aligned path):
- `requestSign({domain, payloadHash:<hex32>, caller, scheme:"ecdsa"})` → `{signId, status:"pending"}`.
  No card needed at call time — the request is queued.
- The user approves in **keycard-ui** (it polls `getPendingSigns` → `approveSign(signId, pin)`;
  the PIN + tap live entirely there — loam_core never handles the PIN).
- `checkSignStatus(signId)` → `pending` | `{status:"complete", signature:<hex>}` | `{status:"failed",
  error}` | `{error:"Sign request not found"}` (expired). **`complete` is one-read-and-drop** — the
  request is wiped after the first complete read, so read the signature on the first hit.
- The ECDSA signature is **65 bytes `R‖S‖V`** (Ethereum shape). We drop `V` and low-S-normalise to the
  **64-byte `r‖s`** scala/loam verify expects; the `V` byte also lets us **recover the pubkey** at
  enrol without any extra API.

Note: wrong PIN / PIN-lockout do **not** surface as terminal `failed` — they hold at `pending`
([keycard #93](https://github.com/xAlisher/keycard-basecamp/issues/93)). The poller must apply its
own timeout (we cap at ~180 polls × 1 s).

## Decision — async delegation in loam_core, event-driven, non-blocking

All keycard work is **async** (per "everything async in Basecamp") and never blocks loam_core's
thread — it mirrors the existing `refreshMetrics` pattern (`…Async` caller + `QTimer` + an event).

**Enrol** — `enrollKeycard(label, domain, ref)`:
1. compute an enrol digest `sha256("loam-keycard-enroll-v1:"+domain)`;
2. `requestSignAsync({domain, payloadHash:digest, caller:"loam", scheme:"ecdsa"})` → `signId`;
3. self-rescheduling `checkSignStatusAsync` poll until `complete`;
4. `ecdsaRecover(digest, R‖S‖V)` → the card's pubkey/address (key never leaves the card);
5. store `{id, kind:"keycard", label, domain, address, pubHex}` (public material only);
6. emit `keycardSignResult(ref, meta)`.

**Sign per event** — `keycardSign(containerId, digestHex, ref)`:
1. resolve the container's bound keycard identity (kind must be `keycard`);
2. `requestSignAsync` at the identity's `domain` + poll as above;
3. on `complete`: `compact64LowS(65B)` → 64B; **guard** by recovering the pubkey and comparing to the
   enrolled `pubHex` (rejects a *wrong card* with a clear error);
4. emit `keycardSignResult(ref, {sig, pub, address})`.

`ref` is a caller-chosen correlation id (scala uses the pending event's id / `"enroll:<domain>"`), so
scala matches each async result to the write it is authoring.

**All crypto stays in loam_core** (`loam_identity.hpp`): `ecdsaRecover` (pubkey from `R‖S‖V`) and
`compact64LowS` (65B→64B low-S) were added beside the existing `identityFromPriv`/`ecdsaSignLowS`.
A keycard identity holds **no private key** — `signDigest` for it returns a `keycard-delegated`
sentinel; callers must use `keycardSign` instead.

## No fold / wire change
A card-signed event is a normal signed event (`pub`/`sig`/`dev`) — it verifies identically to a
software-signed one on every peer, and always-require-signatures
([ADR 0015](0015-full-form-calendar-create.md)) accepts it and drops unsigned writes.

## What is DONE vs. what remains

**Done + compile-verified (2026-08-18), no card required:**
- `keycard` declared as a loam_core dependency; typed `modules().keycard.*` caller generates
  (`nix build ./core#generate` emits `keycard_api.h`).
- `loam_identity.hpp`: `ecdsaRecover`, `compact64LowS`, and the **keycard identity kind** (storage,
  `metaFor`/`listIdentities`/`exists`, `addKeycardIdentity`/`removeKeycardIdentity`).
- `loam_core_impl`: `enrollKeycard` / `keycardSign` / `removeKeycardIdentity` + the
  `keycardSignResult` event + the async poll helpers. `nix build ./core#lib` compiles clean.

**Done + render-verified (2026-08-18), no card required — scala async authoring:**
- Core: `authorAndPublish` routes every user write (CAL_META/EVENT_PUT/EVENT_DEL/MEMBER_SET) through
  `authorEvent`, which for a `kind=="keycard"` calendar builds the unsigned event, calls
  `keycardSign(calId, digestHex, ref)`, and parks it; `onKeycardSignResult` attaches `{sig,pub}` and
  publishes. **SYNC_REQ never routes here** (it keeps the local key via `mkEvent`'s
  `keycard-delegated` fallback — no card tap for reconciliation). `enrollKeycard` + a `keycardState`
  poll snapshot + the `keycardStatus` event round it out.
- View (`CalendarView.qml`, poll-based like the rest): a 💳 badge + removal for keycard identities,
  a "💳 Enroll Keycard" action in the Identities panel (delegates to loam — scala holds no keycard
  logic), and a poll-driven "hold your Keycard" overlay (spinner while pending, error on failure).
  Render-verified in `qml-harness` (`shots/05-identities.png`, `shots/06-keycard-overlay.png`).

**Needs the card (+ reader + keycard & keycard-ui LGX) — the on-card test checklist:**
1. Enrol: `enrollKeycard` → assert the recovered **address equals the mobile Keycard address** for
   domain `"scala"` (the whole point — one card, one identity across phone + desktop).
2. Author an event via `keycardSign`; assert `verifyEvent` passes locally and the 64B low-S sig is
   accepted on fold.
3. Confirm the card-signed desktop event **syncs to the phone** and verifies there, and vice-versa.
4. Wrong card: sign a calendar bound to card A with card B → the pubkey-recovery guard rejects it.
5. Poller: pull the card mid-sign / enter a wrong PIN → the view times out with a clear error, not a
   hang (wrong PIN stays `pending`; our ~180 s cap resolves it).
