# 5. Optional field-schema — calendar as a library

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Real users want specialised calendars (a Lisbon-nightlife planner: venues, artists, crew,
status, tags…). We want Scala to be **usable as a library and protocol** for those apps —
without turning the plain calendar into a form-builder that a normal person has to
understand. The governing rule: **a schema-less calendar must look and feel exactly like
today's.**

## Decision

A calendar may carry an **optional custom-field schema** in its log (`cal.meta.schema`,
LWW — replaced whole by an admin), a list of `{key, label, type, options?}`. Types are a
small closed set (`text, longtext, number, date, datetime, bool, url, enum, color, geo,
ref`). Field **values** live on the event payload (the fold already passes the whole
payload through, so custom fields need *no* engine change).

- **Scala renders generically by type** (a default widget per type). A custom UI can render
  the same data richly — "one artifact, two depths": the planner uses it as-is; a builder
  digs deeper on the same log/sync/roles.
- **Empty by default.** No schema ⇒ nothing extra renders. This is a hard invariant and the
  acceptance test for the feature.
- The `ref` type (a reference into another collection's id) is the bridge to *separate*
  collections (venues/artists/crew/budget) — those are their own event-logs on logos-sync,
  not calendar fields. Scala provides the calendar collection + the pattern; a domain app
  composes calendar (Scala) + budget (KYM) + custom collections behind a custom UI.

## Rejected

- **Hardcode location/links/type fields** — would serve Scala but not the reusable goal;
  the schema serves both.
- **A generic "database with a UI"** — keep time-anchoring, recurrence and roles first-class
  in the calendar engine; everything domain-specific is additive via fields/refs.

## Consequences

- Scala stays a plain calendar for the many, and a calendar *building block* for the few.
  The schema is the whole extensibility surface — no Freequencies-specific line in Scala.
