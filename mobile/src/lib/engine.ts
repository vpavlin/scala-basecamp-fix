// Scala calendar engine — the pure, deterministic fold from a merged event log to
// calendar state. This is a BYTE-FOR-BYTE mirror of the desktop core's
// src/scala_engine.hpp (event-log CRDT): every change is an immutable event;
// current state = fold over the merged log. Merge = union-by-id + HLC sort, so it
// is idempotent (redelivery is a no-op), commutative and associative (arrival
// order is irrelevant) — offline devices converge with no lost writes.
//
// One channel == one calendar; its log holds that calendar's events. Keep this in
// lockstep with scala_engine.hpp; the golden-vector parity test (test/parity)
// guards the two against drift.

// ── HLC (hybrid logical clock): total order wall → ctr → dev ─────────────────
export interface HLC {
  wall: number; // ms epoch (int64 on desktop; safe integer here)
  ctr: number;
  dev: string;
}
export function compareHlc(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.ctr !== b.ctr) return a.ctr < b.ctr ? -1 : 1;
  if (a.dev !== b.dev) return a.dev < b.dev ? -1 : 1;
  return 0;
}

// ── Event: the immutable unit. id (UUIDv4) is the idempotency/dedup key ──────
export interface Event {
  v: number;
  id: string;
  type: string;
  hlc: HLC;
  dev: string;
  payload: any;
}

// Event type constants — keep in lockstep with scala_engine.hpp ET::.
export const ET = {
  CAL_META: "cal.meta", // {name,color}           — calendar metadata (LWW)
  EVENT_PUT: "event.put", // {id,title,startTime,…} — create/edit an event (LWW upsert by id)
  EVENT_DEL: "event.del", // {id}                   — tombstone an event (terminal)
  SYNC_REQ: "sync.req", // {from}                  — catch-up: ask peers to re-serve; NOT stored/folded
} as const;

export function eventToJson(e: Event): any {
  return {
    v: e.v,
    id: e.id,
    type: e.type,
    hlc: { wall: e.hlc.wall, ctr: e.hlc.ctr, dev: e.hlc.dev },
    dev: e.dev,
    payload: e.payload,
  };
}
export function eventFromJson(j: any): Event {
  const hlc = j && j.hlc && typeof j.hlc === "object" ? j.hlc : {};
  return {
    v: typeof j?.v === "number" ? j.v : 1,
    id: typeof j?.id === "string" ? j.id : "",
    type: typeof j?.type === "string" ? j.type : "",
    hlc: {
      wall: typeof hlc.wall === "number" ? hlc.wall : 0,
      ctr: typeof hlc.ctr === "number" ? hlc.ctr : 0,
      dev: typeof hlc.dev === "string" ? hlc.dev : "",
    },
    dev: typeof j?.dev === "string" ? j.dev : "",
    payload: j && typeof j.payload === "object" && j.payload !== null ? j.payload : {},
  };
}

// Union by id, sort by HLC. Idempotent — redelivery is a no-op. Pure.
export function mergeEvents(...logs: Event[][]): Event[] {
  const byId = new Map<string, Event>();
  for (const log of logs) for (const e of log) if (e.id && !byId.has(e.id)) byId.set(e.id, e);
  const out = [...byId.values()];
  out.sort((x, y) => compareHlc(x.hlc, y.hlc));
  return out;
}

export interface FoldedCalendar {
  id: string;
  name: string;
  color: string;
  events: any[];
}

// ── fold: merged log → calendar state ────────────────────────────────────────
// Returns {id, name, color, events:[…]}. cal.meta is LWW (last by HLC wins).
// Events are LWW upsert by event id; a tombstone is TERMINAL (a later edit can't
// resurrect it). Mirrors scala_engine.hpp foldCalendar exactly.
export function foldCalendar(calId: string, log: Event[]): FoldedCalendar {
  const ordered = mergeEvents(log);
  let name = "";
  let color = "";
  const events = new Map<string, any>(); // event id -> payload
  const tombstones = new Set<string>();

  for (const e of ordered) {
    if (e.type === ET.CAL_META) {
      if (Object.prototype.hasOwnProperty.call(e.payload, "name")) name = e.payload.name ?? name;
      if (Object.prototype.hasOwnProperty.call(e.payload, "color")) color = e.payload.color ?? color;
    } else if (e.type === ET.EVENT_PUT) {
      const id: string = e.payload?.id ?? "";
      if (!id || tombstones.has(id)) continue; // tombstone terminal
      const ev = { ...e.payload, calendarId: calId, creatorId: e.dev };
      events.set(id, ev);
    } else if (e.type === ET.EVENT_DEL) {
      const id: string = e.payload?.id ?? "";
      if (id) {
        tombstones.add(id);
        events.delete(id);
      }
    }
  }

  // Match C++ std::map iteration: events ordered by id string.
  const ids = [...events.keys()].sort();
  return { id: calId, name, color, events: ids.map((id) => events.get(id)) };
}

// ── Clock: stamps local events, advances past ingested causes ────────────────
// Mirrors the desktop nextHlc (wall→ctr bump) and additionally primes from the
// whole log on load + advances on every ingest (receive), so mobile-authored
// events causally sort after everything it has already seen. This is strictly a
// correctness improvement over the desktop clock and does NOT affect the wire or
// the fold (convergence is over the merged set, independent of either clock).
export class Clock {
  wall = 0;
  ctr = 0;
  dev: string;
  constructor(dev: string) {
    this.dev = dev;
  }
  // Prime from an existing log so we never author an event that sorts before a
  // cause we already hold.
  primeFrom(log: Event[]) {
    for (const e of log) this.observe(e.hlc);
  }
  private observe(remote: HLC) {
    if (remote.wall > this.wall) {
      this.wall = remote.wall;
      this.ctr = remote.ctr;
    } else if (remote.wall === this.wall && remote.ctr > this.ctr) {
      this.ctr = remote.ctr;
    }
  }
  receive(remote: HLC) {
    this.observe(remote);
  }
  send(now: number): HLC {
    if (now > this.wall) {
      this.wall = now;
      this.ctr = 0;
    } else {
      this.ctr += 1;
    }
    return { wall: this.wall, ctr: this.ctr, dev: this.dev };
  }
}
