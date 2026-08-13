# 0. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Scala grew a lot of load-bearing decisions — how state converges, how a phone and a
desktop stay identical, how catch-up works, how roles and custom fields are modelled —
and until now they lived only in commit messages and people's heads. The old
`docs/PLAN.md` and `migration-plan-*.md` described a *destination we've already reached*
and were actively misleading. These ADRs replace them with a durable record of the
decisions and *why*.

Scala sits on two shared libraries; the decisions specific to *those* layers live in
their own ADRs and are cross-referenced rather than restated:
- **[logos-sync](https://github.com/vpavlin/logos-sync)** — the event-log CRDT, HLC,
  merge, and recursive-RBSR catch-up (scala is its first consumer).
- **[logos-transport](https://github.com/vpavlin/logos-transport)** — the byte transport
  (Waku node, SDS channels, the shared "Loam" node, the offline cache).

## The log

- [0001](0001-event-log-crdt.md) — Event-log CRDT + pure fold, not mutable rows
- [0002](0002-adopt-logos-sync.md) — Adopt logos-sync (extract the sync spine)
- [0003](0003-catch-up-recursive-rbsr.md) — Catch-up = recursive RBSR + reliable trigger
- [0004](0004-roles-opt-in.md) — Roles: opt-in, default-open, enforced on merge
- [0005](0005-optional-field-schema.md) — Optional field-schema — calendar as a library
- [0006](0006-two-clients-one-fold.md) — Two clients, one fold (C++ ↔ TS parity) + AES-GCM crypto

Superseded planning docs are archived under [`../archive/`](../archive/).
