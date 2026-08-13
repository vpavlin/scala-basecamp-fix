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
import { verifyEvent, isSigned } from "./identity";

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
  pub?: string; // author's 33B secp256k1 public key (hex) — authenticity layer
  sig?: string; // 64B ECDSA over the canonical event (hex); absent on legacy events
}

// Event type constants — keep in lockstep with scala_engine.hpp ET::.
export const ET = {
  CAL_META: "cal.meta", // {name,color}           — calendar metadata (LWW)
  EVENT_PUT: "event.put", // {id,title,startTime,…} — create/edit an event (LWW upsert by id)
  EVENT_DEL: "event.del", // {id}                   — tombstone an event (terminal)
  MEMBER_SET: "member.set", // {member,role}        — roles (#3): owner/admin grants admin|viewer|remove; opt-in
  SYNC_REQ: "sync.req", // {from}                  — catch-up: ask peers to re-serve; NOT stored/folded
} as const;

export function eventToJson(e: Event): any {
  const j: any = {
    v: e.v,
    id: e.id,
    type: e.type,
    hlc: { wall: e.hlc.wall, ctr: e.hlc.ctr, dev: e.hlc.dev },
    dev: e.dev,
    payload: e.payload,
  };
  if (e.pub) j.pub = e.pub;
  if (e.sig) j.sig = e.sig;
  return j;
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
    ...(typeof j?.pub === "string" ? { pub: j.pub } : {}),
    ...(typeof j?.sig === "string" ? { sig: j.sig } : {}),
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
  description: string;
  schema: any[];
  owner: string;
  roles: Record<string, string>;
  rolesConfigured: boolean;
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
  let description = "";
  let owner = "";
  let schema: any[] = []; // OPTIONAL custom-field defs; empty by default (plain calendar)
  const events = new Map<string, any>(); // event id -> payload
  const tombstones = new Set<string>();

  // Roles (#3), opt-in + default-open — parity with scala_engine.hpp. owner = author of
  // the earliest cal.meta; until the first member.set the calendar is OPEN (anyone with
  // the key writes). Once configured, only owner/admins write. Single HLC-ordered pass.
  const roleOf = new Map<string, string>(); // dev -> "admin"|"viewer"
  let rolesConfigured = false;
  // Authenticity gate — parity with scala_engine.hpp. A role-managed calendar trusts an
  // author claim only when the event is signed by that author (verified); an OPEN calendar
  // admits anyone (and legacy unsigned events). Signing gates roles, not writing.
  const canWrite = (dev: string, verified: boolean): boolean => {
    if (!rolesConfigured) return true;
    if (!verified) return false;
    return dev === owner || roleOf.get(dev) === "admin";
  };

  for (const e of ordered) {
    // A present-but-invalid signature = forgery/tampering → drop. Unsigned (legacy) events
    // are admitted but never count as an authenticated author.
    const signed = isSigned(e);
    const verified = signed && verifyEvent(e);
    if (signed && !verified) continue;
    const author = e.dev;
    if (e.type === ET.CAL_META) {
      if (!owner) owner = author; // creator = first cal.meta author
      if (!canWrite(author, verified)) continue;
      const p: any = e.payload;
      if (Object.prototype.hasOwnProperty.call(p, "name")) name = p.name ?? name;
      if (Object.prototype.hasOwnProperty.call(p, "color")) color = p.color ?? color;
      if (Object.prototype.hasOwnProperty.call(p, "description")) description = p.description ?? description;
      if (Array.isArray(p.schema)) schema = p.schema;
    } else if (e.type === ET.MEMBER_SET) {
      // A role grant is admitted only from an AUTHENTICATED owner/admin.
      if (!owner || !verified || !(author === owner || roleOf.get(author) === "admin")) continue;
      const m: string = (e.payload as any)?.member ?? "";
      const r: string = (e.payload as any)?.role ?? "";
      if (!m || m === owner) continue; // owner role is fixed
      rolesConfigured = true;
      if (r === "remove") roleOf.delete(m);
      else if (r === "admin" || r === "viewer") roleOf.set(m, r);
    } else if (e.type === ET.EVENT_PUT) {
      if (!canWrite(author, verified)) continue; // viewer/forged edits dropped
      const id: string = e.payload?.id ?? "";
      if (!id || tombstones.has(id)) continue; // tombstone terminal
      const ev = { ...e.payload, calendarId: calId, creatorId: e.dev };
      events.set(id, ev);
    } else if (e.type === ET.EVENT_DEL) {
      if (!canWrite(author, verified)) continue;
      const id: string = e.payload?.id ?? "";
      if (id) {
        tombstones.add(id);
        events.delete(id);
      }
    }
  }

  // Match C++ std::map iteration: events ordered by id string.
  const ids = [...events.keys()].sort();
  const roles: Record<string, string> = {};
  [...roleOf.keys()].sort().forEach((k) => (roles[k] = roleOf.get(k)!));
  return { id: calId, name, color, description, schema, owner, roles, rolesConfigured, events: ids.map((id) => events.get(id)) };
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
