// App logic: bridges the local CRDT log store and the event wire. Authors local
// edits as immutable events (cal.meta / event.put / event.del), merges inbound
// events into the log, and folds for the UI — the exact model the desktop core
// (scala_impl.cpp publishAndApply / applyIncoming) uses. Also parses/builds the
// `scala://` invite links the desktop uses to share a calendar's key.
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fromByteArray, toByteArray } from "base64-js";
import { store, Calendar, CalEvent } from "./store";
import { Event, ET, Clock, eventToJson, eventFromJson } from "./engine";
import { utf8Bytes, utf8Decode } from "./utf8";
import * as sync from "./scala-sync";

// ── device identity (SDS senderId + event author) ───────────────────────────
// A stable per-install id, used to attribute our writes (event.dev / hlc.dev).
export async function getDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync("scala-device-id");
  if (!id) {
    id = "scala-" + Crypto.randomUUID().replace(/-/g, "");
    await SecureStore.setItemAsync("scala-device-id", id);
  }
  return id;
}

// ── clock + event construction (mirrors scala_impl.cpp nextHlc / mkEvent) ────
let clock: Clock | null = null;
let deviceId = "scala-default";
// Lazily create the clock, prime it from every calendar's log so we never author
// an event that sorts before a cause we already hold.
async function ensureClock(): Promise<Clock> {
  if (clock) return clock;
  deviceId = await getDeviceId();
  const c = new Clock(deviceId);
  for (const r of await store.getRegistry()) c.primeFrom(await store.getLog(r.id));
  clock = c;
  return c;
}
async function mkEvent(type: string, payload: any): Promise<Event> {
  const c = await ensureClock();
  return { v: 1, id: Crypto.randomUUID(), type, hlc: c.send(Date.now()), dev: deviceId, payload };
}
// Append locally (persist FIRST — the authored event has no other copy until it's
// both on disk and on the wire), then broadcast the raw event JSON.
async function publishAndApply(calId: string, e: Event): Promise<void> {
  await store.appendEvent(calId, e);
  await sync.sendEvent(calId, JSON.stringify(eventToJson(e))).catch(() => {});
}

// ── catch-up (qaku SYNC_REQ + seed) ──────────────────────────────────────────
const lastServe: Record<string, number> = {};
// Re-broadcast our whole log for a calendar (answers a SYNC_REQ). Rate-limited per
// calendar so overlapping requests can't flood; idempotent (peers dedup by id).
async function serveLog(calId: string): Promise<void> {
  const now = Date.now();
  if (lastServe[calId] && now - lastServe[calId] < 3000) return;
  lastServe[calId] = now;
  for (const e of await store.getLog(calId)) {
    await sync.sendEvent(calId, JSON.stringify(eventToJson(e))).catch(() => {});
  }
}
// Ask peers to re-serve (broadcast a SYNC_REQ on join). Not stored/folded.
async function sendSyncReq(calId: string): Promise<void> {
  const e = await mkEvent(ET.SYNC_REQ, { from: deviceId });
  await sync.sendEvent(calId, JSON.stringify(eventToJson(e))).catch(() => {});
}

// ── scala:// invite links — MUST match the desktop core byte-for-byte ─────────
// scala://join?id=<calendarId>&key=<b64url(encryptionKey)>&name=<name>
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

// ── inbound: merge one received event into the calendar's log ────────────────
sync.setEventHandler((calendarId, eventJson) => {
  void (async () => {
    try {
      const j = JSON.parse(eventJson);
      const e = eventFromJson(j);
      if (!e.id) return;
      // CATCH-UP: a peer asking for state — re-serve our log, don't store it.
      if (e.type === ET.SYNC_REQ) { await serveLog(calendarId); return; }
      (await ensureClock()).receive(e.hlc); // advance past the ingested cause
      const isNew = await store.appendEvent(calendarId, e); // idempotent (dedup by id)
      if (isNew) notifyChange();
    } catch {
      /* malformed event — ignore */
    }
  })();
});

// ── outbound: local edits → append event + publish ──────────────────────────
// Build an event.put payload from UI fields (never carry calendarId/creatorId —
// the fold sets those). Mirrors scala_impl.cpp createEvent/updateEvent.
function putPayload(id: string, f: Partial<CalEvent>): any {
  const p: any = { id };
  if (f.title !== undefined) p.title = f.title;
  if (f.startTime !== undefined) p.startTime = f.startTime;
  if (f.endTime !== undefined) p.endTime = f.endTime;
  if (f.description !== undefined) p.description = f.description;
  if (f.location !== undefined) p.location = f.location;
  return p;
}

export async function createEvent(
  calendarId: string,
  fields: Omit<CalEvent, "id" | "calendarId">,
): Promise<CalEvent> {
  const id = Crypto.randomUUID();
  await publishAndApply(calendarId, await mkEvent(ET.EVENT_PUT, putPayload(id, fields)));
  notifyChange();
  return { ...fields, id, calendarId } as CalEvent;
}

export async function updateEvent(ev: CalEvent): Promise<void> {
  await publishAndApply(ev.calendarId, await mkEvent(ET.EVENT_PUT, putPayload(ev.id, ev)));
  notifyChange();
}

export async function deleteEvent(ev: CalEvent): Promise<void> {
  await publishAndApply(ev.calendarId, await mkEvent(ET.EVENT_DEL, { id: ev.id }));
  notifyChange();
}

// Create a NEW shared calendar on this device. Generates the id + a symmetric
// encryptionKey in the SAME format the desktop uses (two concatenated UUIDv4
// strings, dashes and all — crypto.ts's key derivation matches it byte-for-byte),
// registers membership, starts syncing, and publishes a cal.meta event. The
// invite (buildInvite) carries name+key so a joiner gets metadata even before the
// first cal.meta event reaches them.
export async function createCalendar(name: string, color = "#89b4fa"): Promise<Calendar> {
  const id = Crypto.randomUUID();
  const encryptionKey = Crypto.randomUUID() + Crypto.randomUUID();
  const nm = name.trim() || "My calendar";
  await store.upsertReg({ id, key: encryptionKey, name: nm, color, isShared: true, creatorId: await getDeviceId() });
  await sync.joinCalendar(id, encryptionKey);
  await publishAndApply(id, await mkEvent(ET.CAL_META, { name: nm, color }));
  notifyChange();
  return { id, name: nm, color, isShared: true, encryptionKey, creatorId: deviceId };
}

export async function joinFromInvite(link: string): Promise<Calendar | null> {
  const inv = parseInvite(link);
  if (!inv) return null;
  // Register membership; name/color arrive via cal.meta events once synced (the
  // invite name seeds the registry so the UI isn't blank in the meantime).
  await store.upsertReg({
    id: inv.calendarId,
    key: inv.key,
    name: inv.name || "Shared calendar",
    color: "#89b4fa",
    isShared: true,
  });
  await sync.joinCalendar(inv.calendarId, inv.key);
  await sendSyncReq(inv.calendarId).catch(() => {}); // just joined → pull history
  notifyChange();
  const f = (await store.listCalendars()).find((c) => c.id === inv.calendarId) || null;
  return f;
}

// ── shared-node preference ──────────────────────────────────────────────────
export async function getSharedNode(): Promise<boolean> {
  return (await SecureStore.getItemAsync("scala-shared-node")) === "1";
}
export async function setSharedNode(on: boolean): Promise<void> {
  await SecureStore.setItemAsync("scala-shared-node", on ? "1" : "0");
}

/** Bring sync up on every shared calendar we hold a key for. */
export async function startSyncing(shared?: boolean, onStatus?: (s: string) => void): Promise<void> {
  const useShared = shared ?? (await getSharedNode());
  const regs = await store.getRegistry();
  await sync.startSync({
    deviceId: await getDeviceId(),
    calendars: regs.filter((c) => c.key).map((c) => ({ id: c.id, encryptionKey: c.key })),
    shared: useShared,
    onStatus,
  });
  // Catch-up: ask peers to re-serve each calendar's log. Retried a few times to beat a
  // still-forming mesh (a dropped first SYNC_REQ otherwise = no history). qaku pattern.
  const askAll = () => { for (const c of regs.filter((r) => r.key)) sendSyncReq(c.id).catch(() => {}); };
  askAll();
  setTimeout(askAll, 9000);
  setTimeout(askAll, 24000);
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
