# 9. Multiple authoring identities, bound per calendar

- **Status:** accepted
- **Date:** 2026-08-17

## Context

Scala authored every event with **one global identity** (`getDeviceId` → the enrolled Keycard's
address, else the software key). vpavlin wants per-calendar choice: some calendars authored by a
Keycard, some by a software key; several calendars under one identity, or a distinct identity per
calendar (compartmentalisation — e.g. work vs personal not linkable to one key).

Research finding: **loam already supports this at the primitive level.** `logos-sync`'s signing
seam takes the signer as a *per-call argument* (`signEvent(signer, domain, ev)` / `signEventAsync`
/ `AsyncSigner`), so a different identity per event is native to the SDK. And crucially, **an
event is self-describing** (`pub`/`sig`/`dev`) — the fold/roles verify whatever signed it and
resolve the author from `dev`. So per-calendar identity needs **no change to the fold, the wire,
the C++ core, or Basecamp**. It is purely a mobile concern: a registry, a binding, signer routing,
and UI. (There is no separate `loam-identity` module — identity lives in `logos-sync`; the concrete
Keycard signer is vendored in scala at `src/lib/loam-keycard/`.)

## Decision

**An identity is a keypair that authors events; a calendar is bound to one.** Three kinds
(`src/lib/identities.ts`):

- **`device`** — the built-in software key (`identity.ts` / `scala-identity-key`). Always present.
- **`soft`** — extra *named* software keys the user creates (compartmentalise without a card).
  Privkeys in SecureStore; a small registry `[{id,label}]` in AsyncStorage.
- **`keycard`** — the enrolled Keycard (present iff enrolled; signs via NFC tap).

**Per-calendar binding** (`calId → identityId`, AsyncStorage). A calendar with no binding falls
back to the **default identity** (an explicit choice, else keycard-if-enrolled-else-device) — so
**pre-feature calendars behave exactly as before**. Authoring routes through
`authorEvent(calId, ev)` which resolves the calendar's identity and signs (soft/device locally;
keycard via the tap flow, throwing on cancel). `mkEvent` now takes the `calId`; `createCalendar`
takes an `identityId`, **binds before authoring** so the `cal.meta` (whose author becomes the
OWNER) is signed by the chosen identity.

**UI:** an *Identities* panel (list; ★ default, tap to set; add/remove software identities; the
Keycard set-up/lock controls) and an "author as …" identity picker on calendar creation. Joining
an invite uses the default identity for now (rebindable later).

## Consequences

- Full flexibility: one identity across many calendars, or one per calendar, mixing hardware and
  software — the owner of each calendar is the identity that created it.
- **Zero wire/fold/C++/Basecamp change** — every event stays self-describing; a card-authored event
  and a software-authored event verify identically on the desktop.
- The clock/senderId uses the *default* identity's address; per-event authorship is stamped by
  `authorEvent`, so the HLC `dev` on each event is its calendar's identity (correct attribution).
- **No silent drops.** Authoring with an identity a calendar's fold won't accept (wrong owner /
  closed / not a member) is refused **up front** with a clear message (`assertAuthorable`, mirroring
  the fold's `canAdd`/`canEditExisting`) — never stored-then-folded-away with no feedback. Applies to
  create/edit/delete; the editor stays open with a Retry.
- **UI:** the *Identities* panel is collapsible and lives in the drawer (not the main screen);
  calendars are created via a full-form modal with a name/description + an "author as" identity
  picker (Google-Calendar-style account choice, one level up).
- Not yet: rebinding an existing calendar's identity from the UI, per-identity export/backup, and
  choosing an identity when *joining* an invite (defaults for now). These are additive follow-ups.
- Complements ADR [0008](0008-keycard-identity-custody.md): a Keycard is just one identity kind;
  the custody policy still governs how it signs.
