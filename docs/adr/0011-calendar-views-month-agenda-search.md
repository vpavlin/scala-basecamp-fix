# 11. Calendar views — Month, Agenda, Search

- **Status:** accepted (mobile); proposed (Basecamp view)
- **Date:** 2026-08-18

## Context

The app shipped a **Month grid + a per-day event list** only. That's fine for "what's on the 14th?"
but poor for "what's coming up?" and useless for "where's that dentist appointment?". Both clients
already own the pieces needed for more: a recurrence expander (`expandEvents(events, winStart,
winEnd)`) that turns the log's master events into occurrences over any window, identical on mobile
(`recur.ts`) and desktop (`CalendarView.qml expandEvent`).

## Decision

Add two navigation modes on top of the same occurrence data — **no data-model, wire, or fold
change** (per [ADR 0006](0006-two-clients-one-fold.md), views are a client concern):

- **Month** (unchanged) — the grid + selected-day list.
- **Agenda** — occurrences from **today forward** (default horizon 90 days), grouped by day,
  across all calendars, sorted by start time. This is the "what's next" view.
- **Search** — a text box that filters occurrences by **title / location / description**
  (case-insensitive substring) over a **wider window** (−30 days … +365 days), grouped by day.
  Empty query in Agenda = the plain upcoming list.

A simple segmented toggle (`Month | Agenda`) switches modes; the search field shows in Agenda.
Occurrence rows reuse the existing event-row rendering (color dot, title, time/all-day, location)
and open the same editor on tap.

## Consequences

- Pure UI: both are derived from `expandEvents` over a window — no new storage, no new events.
- Search is client-local (no server) and honours recurrence (it searches occurrences, not just
  masters), so a weekly "Standup" matches on any week in range.
- **Basecamp port:** add a `viewMode` ("month"|"agenda") + `query` to `CalendarView.qml`; compute
  an `agenda` list with the existing `expandEvents` over `[todayStart, +90d]` (or `[−30d, +365d]`
  when a query is present) and group by day; render the segmented toggle + a `LogosTextField`
  search box; reuse the day-row delegate. Keep the horizons identical to mobile so the two clients
  describe "upcoming" the same way.
- Not yet: a Week view, saved searches, or search across archived/very-old ranges beyond the window
  (the window is a performance bound; widen if needed).
