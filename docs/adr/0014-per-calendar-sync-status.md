# 14. Per-calendar sync status (offline / syncing N / up-to-date)

- **Status:** accepted (mobile); proposed (Basecamp view)
- **Date:** 2026-08-18

## Context

Sync visibility was **device-level only**: peers/mesh/tx/rx counters (`getDebug()`), a `Connected`
status line, and the shared-node chip. Nothing told you, *per calendar*, whether you were up to date
— which is exactly the moment the offline-first story should be legible ("I edited on the train;
did it land?"). The information already exists: the recursive RBSR catch-up
([ADR 0003](0003-catch-up-recursive-rbsr.md)) computes, during reconciliation, the set of event ids
**this device still needs** — it just was never surfaced.

## Decision

Add a tiny per-calendar observable (`syncstatus.ts`) holding `{online, syncing, behind, lastRecvAt}`,
**fed from the existing catch-up handler** — no new protocol:

- `noteCatchup(calId)` — a reconciliation exchange is live for this calendar.
- `noteNeed(calId, n)` — from the `need` reply, the count of events we still lack (the "behind" N).
- `noteRecv(calId)` — a deficit event landed (decrement; at zero, clear "syncing").
- a short **quiet timer** clears "syncing" when the exchange goes idle.
- `online` is fed from the connection status (`/connected/i`).

The calendar list badges each calendar: **`offline`** / **`syncing N`** / **`up to date`**.

## Consequences

- Cheap and honest: it reflects the reconciliation the app already runs; no extra messages.
- **"up to date" is a freshness signal, not a proof.** It means *online and no active catch-up*, not
  a cryptographic guarantee both sides are byte-identical. A stronger version would only show
  "up to date" on a **confirmed RBSR fingerprint match** (compare the range fingerprints from
  `catchup.ts`); deferred.
- **Basecamp port:** desktop runs the same RBSR (`respond()` in the shared catch-up). Add the
  equivalent per-calendar state fed from the desktop catch-up handler's `need` replies + ingests,
  and badge calendars in `CalendarView.qml`. `online` comes from the same `Connected` status the
  view already tracks. Keep the buckets and the wording identical to mobile so a user reading either
  client sees the same vocabulary.
- Not yet: "synced Xm ago" relative time, a fleet-wide health view, or the fingerprint-confirmed
  "up to date".
