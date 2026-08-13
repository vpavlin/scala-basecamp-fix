# 3. Catch-up = recursive RBSR + a reliable trigger

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The original "sync worked but history never showed up" bug had two causes, both here:

1. **The trigger.** Scala fired a single `SYNC_REQ` at `onReady` — the instant the node
   finished `start()`, *before* the gossip mesh had peers (~10 s to form) and before the
   async subscribe/channel-join completed. That one request went into the void, and there
   was no retry. (A separate belief that "SDS reconciles late joiners" was wrong — SDS
   heals live drops, not cold-start history.)
2. **The transfer.** The first fix re-served the **whole log** on every request; the next
   put the requester's whole id-list in one message — which **segments**, and the delivery
   module can't encrypt multi-segment channel sends.

## Decision

Use logos-sync's **recursive Range-Based Set Reconciliation** (logos-sync ADR 0004):
peers exchange bounded `fp`/`ids`/`need` range statements — always single-segment — and
converge on the **id-exact delta**. A fresh device pulls the whole calendar; a device two
minutes behind pulls only the gap. Wired in `scala_impl.cpp` (`sendSyncReq` →
`catchup::buildInitial`, `onSyncReq` → `catchup::respond`).

**Trigger reliably:** publish the initial reconciliation message at **0 / 3 / 10 / 25 s**
after the node is ready (QTimer on desktop, retry loop on mobile), so it lands after the
mesh forms. Idempotent. The always-on headless hub serves the delta on demand — no
periodic whole-log re-broadcast.

## Consequences

- Cold-start and phone-was-off both converge; verified on-device ("All synced" /
  "the missing message synced"). No segmentation, no steady-state traffic.
- The mobile port keeps a whole-log fallback for a peer that sends an old bare `SYNC_REQ`.
