// App logic: bridges the local store and the sync wire. Applies inbound
// SyncMessages to the store and publishes local edits. Also parses/builds the
// `scala://` invite links the desktop uses to share a calendar's key.
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fromByteArray, toByteArray } from "base64-js";
import { store, Calendar, CalEvent } from "./store";
import { utf8Bytes, utf8Decode } from "./utf8";
import * as sync from "./scala-sync";

// ── device identity (SDS senderId) ──────────────────────────────────────────
// A stable per-install id, used to attribute our writes. The desktop uses a
// pubkey hex; a random stable id is sufficient for attribution (signing parity
// is a later step — see PLAN).
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync("scala-device-id");
  if (!id) {
    id = "scala-" + Crypto.randomUUID().replace(/-/g, "");
    await SecureStore.setItemAsync("scala-device-id", id);
  }
  return id;
}

// ── scala:// invite links — MUST match the desktop core byte-for-byte ─────────
// Desktop (scala_impl.cpp generateShareLink/parseShareLink) format:
//   scala://join?id=<calendarId>&key=<b64url(encryptionKey)>&name=<name>
// where `key` is the encryptionKey string base64URL-encoded (URL-safe, no padding)
// of its UTF-8 bytes. NOT `cal=` and NOT the raw key (that was the incompatibility).
function b64urlEncode(s: string): string {
  return fromByteArray(utf8Bytes(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  return utf8Decode(toByteArray(b));
}
// Robust query parse (RN Hermes has spotty URLSearchParams).
function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.split("&")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    try {
      out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, "%20"));
    } catch { /* skip malformed */ }
  }
  return out;
}

export function parseInvite(link: string): { calendarId: string; key: string; name?: string } | null {
  try {
    const q = link.split("?")[1] || "";
    const p = parseQuery(q);
    const id = p["id"] || "";
    const keyB64 = p["key"] || "";
    if (!id || !keyB64) return null;
    return { calendarId: id, key: b64urlDecode(keyB64), name: p["name"] || undefined };
  } catch {
    return null;
  }
}
export function buildInvite(cal: Calendar): string {
  const key = b64urlEncode(cal.encryptionKey || "");
  return `scala://join?id=${encodeURIComponent(cal.id)}&key=${key}&name=${encodeURIComponent(cal.name)}`;
}

// ── inbound: apply a SyncMessage to the local store ─────────────────────────
sync.setSyncHandler(async (calendarId, msg) => {
  try {
    const data = JSON.parse(msg.payload || "{}");
    switch (msg.type) {
      case "CreateEvent":
      case "UpdateEvent":
        await store.saveEvent({ ...(data as CalEvent), calendarId, updatedAt: msg.timestamp });
        break;
      case "DeleteEvent":
        await store.saveEvent({ id: data.id, calendarId, deleted: true, updatedAt: msg.timestamp } as CalEvent);
        break;
      case "CreateCalendar":
      case "UpdateCalendar":
        await store.saveCalendar({ ...(data as Calendar), id: calendarId, updatedAt: msg.timestamp });
        break;
    }
    notifyChange();
  } catch {
    /* malformed payload — ignore */
  }
});

// ── outbound: local edits → store + publish ─────────────────────────────────
export async function createEvent(
  calendarId: string,
  fields: Omit<CalEvent, "id" | "calendarId" | "updatedAt">,
): Promise<CalEvent> {
  const ev: CalEvent = {
    ...fields,
    id: Crypto.randomUUID(),
    calendarId,
    updatedAt: Date.now(),
  };
  await store.saveEvent(ev);
  await sync.sendMessage(calendarId, "CreateEvent", JSON.stringify(ev)).catch(() => {});
  notifyChange();
  return ev;
}

// Create a NEW shared calendar on this device. Generates the id + a symmetric
// encryptionKey in the SAME format the desktop uses (two concatenated UUIDv4
// strings, dashes and all — crypto.ts's key derivation matches it byte-for-byte),
// starts syncing on its topic, and returns the calendar (buildInvite() gives the
// scala:// link to share). A brand-new calendar has no peers yet; the invite
// carries the name/key so a joiner gets everything.
export async function createCalendar(name: string, color = "#89b4fa"): Promise<Calendar> {
  const cal: Calendar = {
    id: Crypto.randomUUID(),
    name: name.trim() || "My calendar",
    color,
    isShared: true,
    creatorId: await getDeviceId(),
    encryptionKey: Crypto.randomUUID() + Crypto.randomUUID(),
    updatedAt: Date.now(),
  };
  await store.saveCalendar(cal);
  await sync.joinCalendar(cal.id, cal.encryptionKey as string);
  // Announce it on the channel too (harmless if no peers yet; a peer already on
  // the topic — e.g. a desktop that pre-joined — picks up the metadata).
  await sync.sendMessage(cal.id, "CreateCalendar", JSON.stringify(cal)).catch(() => {});
  notifyChange();
  return cal;
}

export async function updateEvent(ev: CalEvent): Promise<void> {
  const next = { ...ev, updatedAt: Date.now() };
  await store.saveEvent(next);
  await sync.sendMessage(ev.calendarId, "UpdateEvent", JSON.stringify(next)).catch(() => {});
  notifyChange();
}

export async function deleteEvent(ev: CalEvent): Promise<void> {
  const tomb = { ...ev, deleted: true, updatedAt: Date.now() };
  await store.saveEvent(tomb);
  await sync.sendMessage(ev.calendarId, "DeleteEvent", JSON.stringify({ id: ev.id })).catch(() => {});
  notifyChange();
}

export async function joinFromInvite(link: string): Promise<Calendar | null> {
  const inv = parseInvite(link);
  if (!inv) return null;
  const cal: Calendar = {
    id: inv.calendarId,
    name: inv.name || "Shared calendar",
    color: "#89b4fa",
    isShared: true,
    encryptionKey: inv.key,
    updatedAt: Date.now(),
  };
  await store.saveCalendar(cal);
  await sync.joinCalendar(cal.id, inv.key);
  notifyChange();
  return cal;
}

// ── shared-node preference ──────────────────────────────────────────────────
// When ON, route through the device-wide Logos Delivery service (approve Scala
// there once) instead of Scala's own embedded node. Read at sync bring-up; a
// change needs a restart to take effect (preferServiceBackend must be set before
// the transport starts).
export async function getSharedNode(): Promise<boolean> {
  return (await SecureStore.getItemAsync("scala-shared-node")) === "1";
}
export async function setSharedNode(on: boolean): Promise<void> {
  await SecureStore.setItemAsync("scala-shared-node", on ? "1" : "0");
}

/** Bring sync up on every shared calendar we hold a key for. Uses the stored
 *  shared-node preference unless one is passed explicitly. */
export async function startSyncing(shared?: boolean, onStatus?: (s: string) => void): Promise<void> {
  const useShared = shared ?? (await getSharedNode());
  const cals = await store.listCalendars();
  await sync.startSync({
    deviceId: await getDeviceId(),
    calendars: cals
      .filter((c) => c.encryptionKey)
      .map((c) => ({ id: c.id, encryptionKey: c.encryptionKey as string })),
    shared: useShared,
    onStatus,
  });
}

// ── tiny change bus so the UI can refresh after inbound/outbound edits ───────
type Listener = () => void;
const listeners = new Set<Listener>();
export function onChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notifyChange() {
  listeners.forEach((l) => l());
}
