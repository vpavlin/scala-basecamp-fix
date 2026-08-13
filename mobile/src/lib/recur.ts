// Recurring events — series-based v1 (ADR: no per-occurrence exceptions yet).
//
// A recurrence rule lives on the master event's payload as `recur`; occurrences are
// EXPANDED at read time (never stored) — so the event log stays one event per series
// and sync/roles/merge are unchanged. Editing or deleting an occurrence acts on the
// master (`seriesId`). The exact same algorithm runs in the desktop QML view (embedded
// JS) so both platforms show identical occurrences.
import { CalEvent } from "./store";

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export interface Recur {
  freq: Freq;
  interval: number; // >= 1
  until?: number;   // epoch ms, inclusive; omitted = open-ended (capped by the query window)
}

// A concrete instance of a (possibly recurring) event within a window.
export interface Occurrence extends CalEvent {
  seriesId: string; // the master event id (edit/delete target)
  occ: number;      // this occurrence's start (same as startTime; explicit for clarity)
}

const MAX_OCCURRENCES = 500; // runaway guard for open-ended rules

// Expand one event into its occurrences overlapping [winStart, winEnd]. A non-recurring
// event yields itself (once) if it overlaps. Deterministic; uses calendar-aware Date
// stepping so month/year lengths are handled correctly.
export function expandEvent(ev: CalEvent, winStart: number, winEnd: number): Occurrence[] {
  const dur = Math.max(0, (ev.endTime || ev.startTime) - ev.startTime);
  const r = ev.recur;
  const mk = (s: number): Occurrence => ({ ...ev, startTime: s, endTime: s + dur, seriesId: ev.id, occ: s });

  if (!r || !r.freq) {
    return ev.startTime + dur >= winStart && ev.startTime <= winEnd ? [mk(ev.startTime)] : [];
  }
  const interval = Math.max(1, Math.floor(r.interval || 1));
  const hardUntil = typeof r.until === "number" ? r.until : Infinity;
  const out: Occurrence[] = [];
  const cur = new Date(ev.startTime);
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const s = cur.getTime();
    if (s > hardUntil || s > winEnd) break;
    if (s + dur >= winStart) out.push(mk(s));
    switch (r.freq) {
      case "daily": cur.setDate(cur.getDate() + interval); break;
      case "weekly": cur.setDate(cur.getDate() + 7 * interval); break;
      case "monthly": cur.setMonth(cur.getMonth() + interval); break;
      case "yearly": cur.setFullYear(cur.getFullYear() + interval); break;
      default: return out;
    }
  }
  return out;
}

// Expand a list of events; returns all occurrences overlapping the window, sorted by start.
export function expandEvents(events: CalEvent[], winStart: number, winEnd: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const ev of events) out.push(...expandEvent(ev, winStart, winEnd));
  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}

// Human-readable recurrence summary for the UI (e.g. "Every 2 weeks").
export function recurLabel(r?: Recur): string {
  if (!r || !r.freq) return "Does not repeat";
  const n = Math.max(1, Math.floor(r.interval || 1));
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  const base = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  return r.until ? `${base}, until ${new Date(r.until).toLocaleDateString()}` : base;
}
