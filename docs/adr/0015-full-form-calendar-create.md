# 15. Full-form calendar create — one signed cal.meta, all fields at creation

- **Status:** accepted (mobile); proposed (Basecamp view)
- **Date:** 2026-08-18

## Context

Creating a calendar used to capture only name (+ maybe description); everything else — custom
fields, the Open toggle, and **signatures-required** — had to be set afterward in settings. That's
two steps for one intent, and it is actively wrong for a **Keycard** calendar: each settings edit is
another `cal.meta` event = another card tap. The fold already accepts all of these fields on a
single `cal.meta` (name/color/description/schema/open/signaturesRequired are LWW meta), and the core
enforces `signaturesRequired` on both clients ([ADR 0009](0009-per-calendar-identity.md) follow-up;
`engine.ts` + `scala_engine.hpp` parity, core ≥ 0.8.5).

## Decision

The create form carries **every meta field the settings sheet has**, folded into the **single
signed `cal.meta`** authored at creation:

- name, description, **custom fields** (schema), **Open** toggle, **🔒 signatures-required** toggle,
  and (mobile) the **author-as identity** picker.
- `createCalendar(name, color, desc, identityId, { schema, open, signaturesRequired })` writes them
  all into the first `cal.meta` — so a Keycard create is **one tap**, not create-then-edit.

**Signatures-required must be settable wherever calendars are created/edited**, on both clients —
the core enforces it, so a client that can't turn it on can't make a "only my key writes here"
calendar. (Don't enable it on a calendar until every device you use is on a client that enforces it,
or a stale peer keeps unsigned writes — see the engine-parity note.)

## Consequences

- One intent, one signed event, one tap. No create-then-edit round-trip.
- **Basecamp port:** the desktop `newCalPopup` already has name + Open/Restricted; extend it to the
  full form — custom-fields editor (the view already has `schemaFor` + the settings schema UI to
  reuse), the Open toggle, and a **signatures-required** toggle — and pass them through the create
  call so they land in the one `cal.meta`. Add the **signatures-required** toggle to calendar
  settings too. Desktop stays single-identity for now (no author-as picker) per
  [ADR 0010](0010-keycard-on-basecamp.md) / [ADR 0013](0013-permission-transparency.md).
- Not yet: templates / duplicate-calendar; per-identity author picker on desktop (blocked on desktop
  multi-identity).
