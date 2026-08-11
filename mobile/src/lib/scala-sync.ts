// Scala mobile sync — the wire the desktop core (src/calendar_sync.cpp) speaks,
// carried over the shared logos-transport (SDS Reliable Channels). Drops onto
// the same per-calendar channel the desktop already listens on.
//
// Wire (must match the desktop byte-for-byte):
//   • topic    = "/scala/1/<calendarId>/json"  (channelId == contentTopic)
//   • message  = SyncMessage JSON (see fields below), UTF-8 bytes
//   • sealed   = AES-256-GCM(message)  ->  nonce||tag||ciphertext  (crypto.ts)
//   • transport double-base64s the sealed bytes for the channel (publishSealed);
//     on receive it hands candidate byte-arrays, we open() each with the
//     calendar's key and take the first that authenticates.
import * as transport from "./logos-transport";
import { seal, open } from "./crypto";
import { utf8Bytes, utf8Decode } from "./utf8";

// ── SyncMessage — mirror of SyncMessage in calendar_sync.cpp ─────────────────
// type is one of the string forms desktop's typeToString emits. payload is the
// serialized event/calendar JSON the app applies. signature = HMAC-SHA256(payload,
// encryptionKey) hex (desktop SyncMessage::sign) — optional, verified if present.
export type SyncType =
  | "CreateEvent" | "UpdateEvent" | "DeleteEvent"
  | "CreateCalendar" | "UpdateCalendar" | "DeleteCalendar"
  | "FullSync";

export interface SyncMessage {
  type: SyncType;
  calendarId: string;
  payload: string;   // JSON string of the event/calendar
  senderId: string;  // our stable device identity
  timestamp: number; // ms
  signature?: string;
}

export function topicForCalendar(calendarId: string): string {
  return `/scala/1/${calendarId}/json`;
}

// One route per shared calendar: its topic + the symmetric key we seal/open with.
interface Route {
  calendarId: string;
  encryptionKey: string;
  topic: string;
}
let routes: Route[] = [];
let deviceId = "scala-default";
let onSync: ((calendarId: string, msg: SyncMessage) => void) | null = null;

/** Register the callback the app uses to apply an inbound SyncMessage. */
export function setSyncHandler(cb: (calendarId: string, msg: SyncMessage) => void) {
  onSync = cb;
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
    try {
      const msg = JSON.parse(utf8Decode(plain)) as SyncMessage;
      if (msg && msg.type) onSync?.(route.calendarId, msg);
    } catch {
      /* opened but not a SyncMessage */
    }
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

/** Add a calendar's route to the live node (after creating/joining one). */
export async function joinCalendar(calendarId: string, encryptionKey: string): Promise<void> {
  if (!routes.find((r) => r.calendarId === calendarId)) {
    routes.push({ calendarId, encryptionKey, topic: topicForCalendar(calendarId) });
  }
  if (transport.getCtx()) await transport.join([topicForCalendar(calendarId)]);
}

/** Publish one SyncMessage on a calendar's channel (sealed with its key). */
export async function sendMessage(
  calendarId: string,
  type: SyncType,
  payload: string,
): Promise<void> {
  const route = routes.find((r) => r.calendarId === calendarId);
  if (!route) return; // not a shared calendar / no key on this device
  const msg: SyncMessage = {
    type,
    calendarId,
    payload,
    senderId: deviceId,
    timestamp: Date.now(),
  };
  const sealed = seal(route.encryptionKey, utf8Bytes(JSON.stringify(msg)));
  await transport.publishSealed(route.topic, sealed);
}

export function stopSync(): Promise<void> {
  routes = [];
  return transport.stop();
}
