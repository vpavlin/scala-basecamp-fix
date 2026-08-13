# 4. Roles: opt-in, default-open, enforced on merge

- **Status:** accepted
- **Date:** 2026-08-13

## Context

A shared calendar wants "owner sets admins; admins create/edit; anyone with the share link
is a viewer" — the Qaku model. But in an append-only p2p log you can't *prevent* a write;
and a plain personal calendar must stay dead-simple with no role ceremony.

## Decision

Roles are folded from `member.set {member, role}` events and **enforced on merge**, not at
write time (`foldCalendar`, C++ + TS parity):

- **owner** = author of the earliest `cal.meta` (deterministic from the log).
- A `member.set` is admitted only if its author is owner/admin; it grants `admin`/`viewer`
  or `remove`. Processed in HLC order, so admission is order-independent and convergent.
- **Default-OPEN:** with *no* `member.set` events, anyone with the key writes — a personal
  or small trusted calendar never sees roles (keeps "anyone can plan" true). Once the owner
  adds the first `member.set`, the calendar becomes role-managed and `event.put/del`/
  `cal.meta` from non-owner/admins **fold away**.

This is **attribution, not cryptographic authorization** (phase 1): the share link carries
the symmetric key, so a determined viewer *could* author events — everyone's fold just
drops them. Fine for honest viewers.

## Rejected / deferred

- **Prevent-at-write** — impossible in an append-only log; admission-on-merge is the
  correct shape.
- **Cryptographic view/write-key split** (viewers physically can't sign a mutation) — the
  real defence against a *malicious* keyholder; deferred until needed (a later crypto layer,
  not a fold change).

## Consequences

- `foldCalendar` returns `owner` / `roles` / `rolesConfigured` for the UI. Enforcement is
  automatic and identical on every device. Edit history (who did what) falls out of the
  event log for free — every event carries its author and time.
