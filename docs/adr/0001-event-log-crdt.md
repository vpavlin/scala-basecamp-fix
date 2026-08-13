# 1. Event-log CRDT + pure fold, not mutable rows

- **Status:** accepted
- **Date:** 2026-07 (foundational)

## Context

Multiple devices (and, with sharing, multiple people) edit the same calendar while
offline and must converge to identical state with no write silently lost. "Store the
calendar, last edit wins" drops concurrent changes — two people editing different events,
or different fields of one event, would clobber each other.

## Decision

A calendar is an **append-only log of immutable events**; its state is a pure,
deterministic **fold** over the merged log (`foldCalendar` in `scala_engine.hpp`, mirrored
in `mobile/src/lib/engine.ts`). Event shape (shared with logos-sync):
`{ v, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }`.

- Event types: `cal.meta` (calendar name/color/description/schema — LWW per field),
  `event.put` (create/edit an event — LWW upsert by payload id), `event.del` (a sticky
  tombstone), `member.set` (roles — ADR 0004), `sync.req` (catch-up control — ADR 0003,
  never stored/folded).
- **Merge = union by id**, then HLC total order — idempotent (redelivery is a no-op),
  commutative, associative ⇒ arrival order is irrelevant and no concurrent write is lost.
- A tombstone is **terminal**: a late edit can't resurrect a deleted event.

## Consequences

- Offline convergence, idempotent redelivery, and conflict-free merge come for free; the
  transport can redeliver freely.
- Everything downstream (roles, schema, catch-up) is expressed as events the fold
  interprets — never as mutations. The generic spine of this now lives in logos-sync
  (ADR 0002); scala keeps only its calendar-specific fold.
