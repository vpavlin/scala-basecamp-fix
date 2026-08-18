# 12. Entering event times in Local or UTC

- **Status:** accepted (mobile); proposed (Basecamp view)
- **Date:** 2026-08-18

## Context

An event's `startTime`/`endTime` are stored as **absolute instants** (ms since epoch). Rendering
with the device's local `Date` is already correct for a *timed* event across zones — an instant is
an instant, so a 15:00 CEST meeting shows as 09:00 EDT for a peer, which is what you want. But when
you're **entering** a time you sometimes know it in a specific zone — most often **UTC** (ops
windows, cross-team calls, "the release goes out at 14:00 UTC"). Forcing mental offset math is
error-prone.

(Full timezone correctness — DST-safe recurrence and all-day events that don't shift across zones —
is a separate, larger decision. This ADR is only about *time entry*.)

## Decision

Add a **`Local | UTC` toggle** to the event editor's time section. It changes **only which
wall-clock the pickers show and parse** — the stored value stays an absolute instant, so there is
**no wire, fold, or storage change** and the two clients interoperate unchanged.

Mechanics (native pickers render in device-local, so we bridge):
- **Display:** in UTC mode, format via `getUTC*` (`HH:MM UTC`, `Wed, Aug 20`) — done manually so it
  is Hermes-safe (no reliance on `Intl` timeZone support).
- **Picker seed:** seed the native picker with `instant + getTimezoneOffset()·60000` so its
  device-local face shows the instant's **UTC** wall-clock.
- **Read-back:** interpret the picked wall-clock as UTC with `setUTCHours` / `setUTCFullYear`
  (vs `setHours` / `setFullYear` in Local mode).

The toggle is a **display/entry preference** — it is NOT gated by edit permission (you can read an
event's time in UTC even when you can't edit it). All-day events ignore it.

## Consequences

- Zero interop cost: the event is the same instant regardless of which zone you typed it in; a
  UTC-entered time round-trips and a peer in another zone sees the correct local time.
- Hermes-safe: no dependency on React Native `Intl`/`toLocaleTimeString({timeZone})` gaps.
- **Basecamp port:** Qt/QML has real `Intl`, so the desktop can format UTC directly
  (`toLocaleTimeString(Qt.locale(), … )` with an explicit UTC date, or `getUTCHours()` for parity).
  Add the same `Local | UTC` toggle to the event popup; seed/read the desktop time control via the
  same offset-shift + `setUTC*` approach (or Qt's native UTC support) so both clients enter times
  identically. Keep it ungated by permission.
- Not yet: a full per-event `tzid`, DST-stable recurrence, or all-day events pinned to a calendar
  date across zones — tracked separately as the "timezone correctness" work.
