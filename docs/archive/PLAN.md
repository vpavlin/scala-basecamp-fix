# Scala mobile — calendar peer over Logos Delivery

A React Native / Expo Android app that syncs shared calendars with the Scala
desktop Basecamp module over Logos Delivery (SDS Reliable Channels), matching the
desktop's wire byte-for-byte.

## Status: SCAFFOLD (sync spine complete, minimal UI)

Done:
- `src/lib/crypto.ts` — **AES-256-GCM** seal/open, byte-compatible with the desktop
  (`src/calendar_sync.cpp`). Layout `nonce(12)||tag(16)||ciphertext`. **Key
  derivation reproduces the desktop's `sscanf("%2hhx")` over the (dashed) UUID
  encryptionKey exactly** — do NOT replace with a clean hex decode or interop breaks.
- `src/lib/scala-sync.ts` — `SyncMessage`, `topicForCalendar(id)="/scala/1/<id>/json"`,
  channel start/join/send/receive over the shared `logos-transport` (submodule).
- `src/lib/store.ts` — AsyncStorage calendars + events, last-write-wins by `updatedAt`.
- `src/lib/calendar.ts` — inbound apply / outbound publish / `scala://` invites / device id.
- `App.tsx` — minimal agenda + join-by-invite + quick-add-event (proves the wire).
- Expo config (`app.json` pkg `xyz.vpavlin.scala`), `logos-transport` submodule + shim,
  `withLogosDelivery` (embedded node) + `withDeliveryClient` (shared node) plugins,
  perun's arm64 native `.so` set under `native/`.

## The wire (ground truth from the desktop — keep in sync)
- topic/channelId/contentTopic = `"/scala/1/<calendarId>/json"`
- SyncMessage JSON `{type, calendarId, payload, senderId, timestamp, signature?}`;
  `type` ∈ Create/Update/Delete × Event/Calendar, `FullSync`. `payload` = JSON of the
  event/calendar. `signature` = HMAC-SHA256(payload, encryptionKey) hex (optional).
- seal = AES-256-GCM(messageBytes) → `nonce||tag||ciphertext`; transport double-base64s
  it onto the channel (publishSealed); receive tries candidates, open() authenticates.
- per-calendar symmetric `encryptionKey` = two concatenated UUIDv4 strings (dashed);
  shared via `scala://join?cal=…&key=…&name=…`.

## TODO (next iterations)
1. `npx expo prebuild` + `assembleRelease`; verify AES **byte-parity** with the desktop
   via a golden-vector test (seal on desktop, open on mobile and vice-versa) BEFORE trusting.
2. Full calendar UI (month/week/day) porting the desktop QML views.
3. `FullSync`/reconcile on join (cold-start backfill — SDS only heals in-session gaps).
4. Event edit/delete, calendar create/share (generate a key + invite) from mobile.
5. Signing parity (secp256k1) if desktop enforces signatures — currently a stub.
6. Publish to the F-Droid repo via `logos-apps/scripts/publish-app.sh`.
7. Shared-node toggle UI (preferServiceBackend("scala")).
