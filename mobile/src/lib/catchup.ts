// catchup.ts — mobile port of logos-sync's v2 catch-up protocol (recursive
// Range-Based Set Reconciliation). Wire- and byte-compatible with the desktop core
// (basecamp/logos_sync/catchup.hpp): peers exchange bounded fp/ids/need range
// statements — always single-segment — and converge on the id-exact delta.
//
// Self-contained + Hermes-safe: the fingerprint uses @noble/hashes utils (no
// Buffer / TextEncoder). The anchor fingerprint(["a","b"]) must equal
// 03e804547dd32e9b71f0d2c78a1279a6 — the same value the desktop C++/TS produce
// (logos-sync docs/PARITY.md), or a phone and a desktop silently fail to converge.
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { Event } from "./engine";

// Order-independent range fingerprint: XOR of SHA-256(id) over 32 bytes, then
// SHA-256(acc ‖ uint32_be(count))[0..16], hex. Identical bytes to the C++ mirror.
function fpIds(ids: string[]): string {
  const acc = new Uint8Array(32);
  for (const id of ids) {
    const h = sha256(utf8ToBytes(id));
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  const buf = new Uint8Array(36);
  buf.set(acc, 0);
  new DataView(buf.buffer).setUint32(32, ids.length); // big-endian count
  return bytesToHex(sha256(buf)).slice(0, 32); // first 16 bytes = 32 hex chars
}

function sortedIds(evs: Event[]): string[] {
  return evs.map((e) => e.id).filter(Boolean).sort();
}
// ids in the half-open range (lo, hi] by string order; undefined = ±infinity.
function idsInRange(ids: string[], lo: string | undefined, hi: string | undefined): string[] {
  return ids.filter((id) => (lo === undefined || id > lo) && (hi === undefined || id <= hi));
}

export interface FpMsg { v: 2; t: "fp"; from: string; lo?: string; hi?: string; bounds: string[]; fps: string[] }
export interface IdsMsg { v: 2; t: "ids"; from: string; lo?: string; hi?: string; ids: string[] }
export interface NeedMsg { v: 2; t: "need"; from: string; ids: string[] }
export type CatchupMsg = FpMsg | IdsMsg | NeedMsg;

function buildFp(from: string, ids: string[], lo: string | undefined, hi: string | undefined, buckets: number): FpMsg {
  const msg: FpMsg = { v: 2, t: "fp", from, bounds: [], fps: [] };
  if (lo !== undefined) msg.lo = lo;
  if (hi !== undefined) msg.hi = hi;
  const n = ids.length;
  const k = Math.max(1, Math.min(buckets, n === 0 ? 1 : n));
  const step = Math.max(1, Math.ceil(n / k));
  for (let i = 0; i < n || (n === 0 && i === 0); i += step) {
    const end = Math.min(n, i + step);
    const last = end >= n;
    msg.fps.push(fpIds(ids.slice(Math.min(i, n), end)));
    if (!last) msg.bounds.push(ids[end - 1]);
    if (n === 0) break;
  }
  return msg;
}

/** The initial message a joining/reconnecting peer publishes. */
export function buildInitial(myEvents: Event[], from: string, buckets = 8): FpMsg {
  return buildFp(from, sortedIds(myEvents), undefined, undefined, buckets);
}

export interface Step {
  replies: CatchupMsg[]; // messages to publish (each single-segment)
  serve: Event[]; // events to publish (the peer lacks these)
}

/** Pure state-machine step for one incoming reconciliation message. */
export function respond(myEvents: Event[], msg: any, me: string, threshold = 8, buckets = 8): Step {
  const step: Step = { replies: [], serve: [] };
  if (!msg || msg.from === me) return step;
  const byId = new Map(myEvents.map((e) => [e.id, e]));
  const mine = sortedIds(myEvents);

  if (msg.t === "fp") {
    const { lo, hi, bounds, fps } = msg as FpMsg;
    const k = fps.length;
    for (let i = 0; i < k; i++) {
      const subLo = i === 0 ? lo : bounds[i - 1];
      const subHi = i === k - 1 ? hi : bounds[i];
      const myItems = idsInRange(mine, subLo, subHi);
      if (fpIds(myItems) === fps[i]) continue;
      if (myItems.length <= threshold) {
        const m: IdsMsg = { v: 2, t: "ids", from: me, ids: myItems };
        if (subLo !== undefined) m.lo = subLo;
        if (subHi !== undefined) m.hi = subHi;
        step.replies.push(m);
      } else {
        step.replies.push(buildFp(me, myItems, subLo, subHi, buckets));
      }
    }
  } else if (msg.t === "ids") {
    const { lo, hi, ids } = msg as IdsMsg;
    const peer = new Set(ids);
    const myItems = idsInRange(mine, lo, hi);
    const mineSet = new Set(myItems);
    for (const id of myItems) if (!peer.has(id)) { const e = byId.get(id); if (e) step.serve.push(e); }
    const need = [...peer].filter((id) => !mineSet.has(id));
    if (need.length) step.replies.push({ v: 2, t: "need", from: me, ids: need });
  } else if (msg.t === "need") {
    for (const id of (msg as NeedMsg).ids) { const e = byId.get(id); if (e) step.serve.push(e); }
  }
  return step;
}
