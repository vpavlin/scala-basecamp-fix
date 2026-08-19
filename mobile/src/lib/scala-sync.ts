// Scala mobile sync — the CRDT event wire the desktop core (src/calendar_sync.cpp
// sendEvent / handleReceive) speaks, carried over the shared loam-transport (SDS
// Reliable Channels). Drops onto the same per-calendar channel the desktop listens
// on.
//
// Wire (must match the desktop byte-for-byte):
//   • topic     = "/scala/1/<calendarId>/json"   (channelId == contentTopic)
//   • plaintext = ONE event's JSON (engine.eventToJson → JSON.stringify):
//                 {v,id,type,hlc:{wall,ctr,dev},dev,payload}   — NOT a SyncMessage
//   • sealed    = AES-256-GCM(plaintext) -> nonce||tag||ciphertext  (crypto.ts)
//   • transport double-base64s the sealed bytes for the channel (publishSealed);
//     on receive it hands candidate byte-arrays, we open() each with the
//     calendar's key and take the first that authenticates.
import * as transport from "./loam-transport";
import { seal, open } from "./crypto";
import { utf8Bytes, utf8Decode } from "./utf8";

export function topicForCalendar(calendarId: string): string {
  return `/scala/1/${calendarId}/json`;
}

// ── debug snapshot (surface in the app's Debug panel) ────────────────────────
// The transport already tracks per-stage counters + diag; this just reads them so
// the phone stops being a black box: publish confirmation (txAttempt vs txTotal vs
// txFail + txErr), receive stages (rxOpened/rxOpenFail/rxNew/rxDup), and node status.
// Pull live node health (peers/mesh) before snapshotting — on the shared-service
// path this fetches the shared node's metrics over AIDL. Call before getDebug().
export function refreshDebug(): Promise<void> {
  return (transport as any).refreshDebug?.() ?? Promise.resolve();
}
export function getDebug() {
  const t = transport as any;
  const c = t.counters || {};
  const d = t.diag || {};
  return {
    mode: t.getNodeMode?.() ?? "?",
    backend: t.getCtx?.() ? "up" : "down",
    routes: routes.length,
    peers: c.peers, mesh: c.mesh,
    tx: { attempt: c.txAttempt ?? 0, sent: c.txTotal ?? 0, fail: c.txFail ?? 0, lastErr: d.txErr || "" },
    rx: { raw: c.rxRaw ?? 0, opened: c.rxOpened ?? 0, openFail: c.rxOpenFail ?? 0, new: c.rxNew ?? 0, dup: c.rxDup ?? 0 },
    sample: t.getRxSample?.() ?? "",
    store: t.getStoreInfo?.() ?? "",
  };
}

// One route per shared calendar: its topic + the symmetric key we seal/open with.
interface Route {
  calendarId: string;
  encryptionKey: string;
  topic: string;
}
let routes: Route[] = [];
let deviceId = "scala-default";
// Handler the app registers to merge one inbound event (raw JSON string) into the
// calendar's log — mirrors the desktop OnEventReceived / applyIncoming path.
let onEvent: ((calendarId: string, eventJson: string) => void) | null = null;

/** Register the callback the app uses to apply an inbound event. */
export function setEventHandler(cb: (calendarId: string, eventJson: string) => void) {
  onEvent = cb;
}

export function deliveryAvailable(): boolean {
  return transport.deliveryAvailable();
}

// Transport hands candidate sealed-byte arrays for a topic; find the calendar
// that owns the topic and open with its key. Returns true iff a candidate
// authenticated (so the transport tallies opened vs failed).
function adapterReceive(topic: string, candidates: Uint8Array[]): boolean {
  const route = routes.find((r) => r.topic === topic);
  if (!route) return false;
  for (const cand of candidates) {
    const plain = open(route.encryptionKey, cand);
    if (!plain) continue; // wrong key / not ours / other candidate
    // Hand the raw decrypted event JSON straight to the CRDT merge path.
    onEvent?.(route.calendarId, utf8Decode(plain));
    return true;
  }
  return false;
}

/** Bring the node up on every shared calendar's topic. Idempotent. Call after
 *  the calendar list (with keys) is known; use joinCalendar() for later adds. */
export async function startSync(opts: {
  deviceId: string;
  calendars: { id: string; encryptionKey: string }[];
  onStatus?: (s: string) => void;
  shared?: boolean; // route through the device-wide Logos Delivery service
}): Promise<void> {
  if (!transport.deliveryAvailable()) throw new Error("Logos Delivery not present in this build");
  deviceId = opts.deviceId || "scala-default";
  routes = opts.calendars
    .filter((c) => c.encryptionKey)
    .map((c) => ({ calendarId: c.id, encryptionKey: c.encryptionKey, topic: topicForCalendar(c.id) }));
  (transport as { preferServiceBackend?: (on: boolean, appId: string) => void })
    .preferServiceBackend?.(!!opts.shared, "scala");
  if (transport.getCtx()) {
    // already up — just join any new topics
    await transport.join(routes.map((r) => r.topic));
    return;
  }
  await transport.start({
    deviceId,
    topics: routes.map((r) => r.topic),
    onReceive: adapterReceive,
    onStatus: opts.onStatus,
  });
}

/** Reliable cold-start history pull: query the fleet store for every joined calendar's topic and
 *  open+fold each stored message (reuses adapterReceive). This is how a freshly-joined calendar
 *  gets events that predate its subscription — SYNC_REQ only re-serves from a LIVE peer, which a
 *  phone frequently can't reach (the "joined but no history" bug). Returns {msgs, events, detail}. */
export async function storeSync(): Promise<{ msgs: number; events: number; detail: string }> {
  return transport.storeSync(adapterReceive);
}

/** Add a calendar's route to the live node (after creating/joining one). */
export async function joinCalendar(calendarId: string, encryptionKey: string): Promise<void> {
  if (!routes.find((r) => r.calendarId === calendarId)) {
    routes.push({ calendarId, encryptionKey, topic: topicForCalendar(calendarId) });
  }
  if (transport.getCtx()) await transport.join([topicForCalendar(calendarId)]);
}

/** Publish one CRDT event on a calendar's channel (sealed with its key). The
 *  argument is the event's JSON string (engine.eventToJson → JSON.stringify). */
export async function sendEvent(calendarId: string, eventJson: string): Promise<void> {
  const route = routes.find((r) => r.calendarId === calendarId);
  if (!route) return; // not a shared calendar / no key on this device
  const sealed = seal(route.encryptionKey, utf8Bytes(eventJson));
  await transport.publishSealed(route.topic, sealed);
}

export function stopSync(): Promise<void> {
  routes = [];
  return transport.stop();
}
