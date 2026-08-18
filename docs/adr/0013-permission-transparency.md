# 13. Permission transparency — say why you can't edit; flag orphaned calendars

- **Status:** accepted (mobile); proposed (Basecamp view)
- **Date:** 2026-08-18

## Context

The fold enforces write permission (owner/editor/viewer + the Open toggle + edit-your-own —
[ADR 0004](0004-roles-opt-in.md)) and, with per-calendar identities ([ADR 0009](0009-per-calendar-identity.md)),
an event is authored by the **calendar's bound identity**, not one global "me". Two failure modes hurt:

1. **Silent lock.** When you couldn't write, the editor just rendered non-editable fields with no
   explanation — indistinguishable from a bug. The sharpest case: a **Keycard-owned calendar whose
   owner address changed** because the card was re-enrolled at a new derivation path — the calendar
   is *orphaned* (owned by a key you no longer control), and the app said nothing.
2. **Wrong "me".** The editability check used a single global identity, so a calendar owned by your
   Keycard read as read-only when your global default was the device key.

## Decision

Make read-only **legible and correct**:

- **Check the calendar's authoring identity**, not one global address. Resolve each calendar's bound
  identity (`identityForCalendar(calId).address`) and test owner/roles against *that* (`addrFor(c)`).
- **Explain why** in the editor: a "🔒 Read-only" box states the specific cause — viewer; closed
  calendar; not-the-author; or owner/identity **mismatch** ("owned by 0x…, you're signing as 0x…;
  if that owner was a re-enrolled Keycard its address changed and this calendar is orphaned").
- **Flag at a glance:** badge non-writable calendars **`read-only`** in the calendar list.
- **Don't lead into the trap:** the new-event flow (`+` and the calendar picker) offers **only
  calendars you can add to** (writable ∩ `canAddTo`), falling back to all writable only if none
  qualify.

## Consequences

- No more silent locks; orphaned Keycard calendars are obvious and self-explaining. We deliberately
  do **not** try to recover them (alpha; owners are fixed by the first `cal.meta`) — the guidance is
  "make a new one / bind an owning identity".
- **Basecamp port:** the view already has `isEditorMe`/`canAddTo`/`canEditEvent`, but keyed on a
  single `myIdentity`. Desktop signs with one software key today (no per-calendar identity yet — see
  [ADR 0010](0010-keycard-on-basecamp.md) for the Keycard path), so `addrFor` collapses to
  `myIdentity` — but still add: (a) the "why read-only" box in the event popup with the same reason
  strings, (b) a `read-only` badge on non-writable calendars, (c) an addable-only calendar picker
  for new events. When desktop gains multiple identities, switch the checks to the per-calendar
  authoring address exactly as mobile did.
