// Per-calendar sync freshness — a tiny observable the drawer chip reads. Device-level health
// (peers/mesh) lives in scala-sync getDebug(); this adds the per-calendar layer the RBSR catch-up
// already computes but never surfaced: are we online, is a catch-up in flight, and how many events
// behind. Fed from calendar.ts's sync handler; `online` is fed from the connection status.
export type CalSync = { online: boolean; syncing: boolean; behind: number; lastRecvAt: number };
type Rec = { syncing: boolean; behind: number; lastRecvAt: number; quiet?: ReturnType<typeof setTimeout> };

const recs = new Map<string, Rec>();
let online = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) { try { l(); } catch { /* */ } } };
const rec = (id: string): Rec => {
  let r = recs.get(id);
  if (!r) { r = { syncing: false, behind: 0, lastRecvAt: 0 }; recs.set(id, r); }
  return r;
};
// A catch-up exchange goes quiet → clear the "syncing" flag a few seconds after the last activity.
const scheduleQuiet = (id: string) => {
  const r = rec(id);
  if (r.quiet) clearTimeout(r.quiet);
  r.quiet = setTimeout(() => { r.syncing = false; r.behind = 0; emit(); }, 4000);
};

export function setOnline(o: boolean): void { if (o !== online) { online = o; emit(); } }
export function noteCatchup(id: string): void { const r = rec(id); r.syncing = true; emit(); scheduleQuiet(id); }
export function noteNeed(id: string, n: number): void { const r = rec(id); r.behind = Math.max(r.behind, n); if (n > 0) r.syncing = true; emit(); scheduleQuiet(id); }
export function noteRecv(id: string): void { const r = rec(id); r.lastRecvAt = Date.now(); if (r.behind > 0) r.behind -= 1; if (r.behind === 0) r.syncing = false; emit(); }

export function getCalSync(id: string): CalSync {
  const r = recs.get(id);
  return { online, syncing: !!r?.syncing, behind: r?.behind ?? 0, lastRecvAt: r?.lastRecvAt ?? 0 };
}
export function onSyncChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
