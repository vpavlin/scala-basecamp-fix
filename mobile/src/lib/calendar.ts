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
import { getIdentity, signEvent } from "./identity";
import * as sync from "./scala-sync";
import { buildInitial, respond } from "./catchup";

// ── device identity (SDS senderId + event author) ───────────────────────────
// The identity is now a secp256k1 keypair (identity.ts); its ADDRESS ("0x…") is the
// verifiable author id used for event.dev / hlc.dev / the SDS senderId. Every authored
// event is signed with the private key and verified on merge.
export async function getDeviceId(): Promise<string> {
  return (await getIdentity()).address;
}

// ── clock + event construction (mirrors scala_impl.cpp nextHlc / mkEvent) ────
let clock: Clock | null = null;
let deviceId = "scala-default";
export function myDeviceId(): string { return deviceId; }
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
  const e: Event = { v: 1, id: Crypto.randomUUID(), type, hlc: c.send(Date.now()), dev: deviceId, payload };
  return signEvent(await getIdentity(), e) as Event; // authenticity: sign as our address
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
// Kick off catch-up: publish the initial reconciliation message (bounded range
// fingerprints over what we hold). Fresh calendar → empty-set fingerprint →
// recurses down to receive everything; slightly behind → only the changed range.
async function sendSyncReq(calId: string): Promise<void> {
  const msg = buildInitial(await store.getLog(calId), deviceId);
  const e = await mkEvent(ET.SYNC_REQ, msg);
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
      // CATCH-UP (logos-sync v2, recursive RBSR): step the reconciliation for one
      // incoming range statement — serve the id-exact missing events + publish the
      // fp/ids/need replies (all single-segment). A payload with no `t` is an OLD
      // peer's bare SYNC_REQ → fall back to a whole-log serve so we still feed it.
      if (e.type === ET.SYNC_REQ) {
        const msg: any = e.payload;
        if (!msg || !msg.t) { await serveLog(calendarId); return; }
        const step = respond(await store.getLog(calendarId), msg, deviceId);
        for (const ev of step.serve)
          await sync.sendEvent(calendarId, JSON.stringify(eventToJson(ev))).catch(() => {});
        for (const r of step.replies)
          await sync.sendEvent(calendarId, JSON.stringify(eventToJson(await mkEvent(ET.SYNC_REQ, r)))).catch(() => {});
        return;
      }
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
function putPayload(id: string, f: any): any {
  const p: any = { id };
  if (f.title !== undefined) p.title = f.title;
  if (f.startTime !== undefined) p.startTime = f.startTime;
  if (f.endTime !== undefined) p.endTime = f.endTime;
  if (f.description !== undefined) p.description = f.description;
  if (f.location !== undefined) p.location = f.location;
  if (f.url !== undefined) p.url = f.url;
  if (f.allDay !== undefined) p.allDay = f.allDay;
  if (f.reminderMin !== undefined) p.reminderMin = f.reminderMin;
  if (f.recur !== undefined) p.recur = f.recur; // recurrence rule (fold passes it through)
  // Custom schema fields (#8) travel under `fields`; the fold passes them through.
  if (f.fields !== undefined) p.fields = f.fields;
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
export async function createCalendar(name: string, color = "#89b4fa", description = ""): Promise<Calendar> {
  const id = Crypto.randomUUID();
  const encryptionKey = Crypto.randomUUID() + Crypto.randomUUID();
  const nm = name.trim() || "My calendar";
  await store.upsertReg({ id, key: encryptionKey, name: nm, color, isShared: true, creatorId: await getDeviceId() });
  await sync.joinCalendar(id, encryptionKey);
  const meta: any = { name: nm, color };
  if (description.trim()) meta.description = description.trim();
  await publishAndApply(id, await mkEvent(ET.CAL_META, meta));
  notifyChange();
  return { id, name: nm, color, isShared: true, encryptionKey, creatorId: deviceId };
}

// Edit a calendar's SHARED metadata (cal.meta, LWW per field) — name/color/description
// travel in the event log to every device. Only the changed fields are written.
export async function updateCalendarMeta(
  calId: string,
  fields: { name?: string; color?: string; description?: string; schema?: any[] },
): Promise<void> {
  const p: any = {};
  if (fields.name !== undefined) p.name = fields.name.trim();
  if (fields.color !== undefined) p.color = fields.color;
  if (fields.description !== undefined) p.description = fields.description.trim();
  if (fields.schema !== undefined) p.schema = fields.schema;
  if (Object.keys(p).length === 0) return;
  if (p.name !== undefined || p.color !== undefined) {
    const reg = (await store.getRegistry()).find((r) => r.id === calId);
    if (reg) await store.upsertReg({ ...reg, name: p.name ?? reg.name, color: p.color ?? reg.color });
  }
  await publishAndApply(calId, await mkEvent(ET.CAL_META, p));
  notifyChange();
}

// Edit history (#4) for one event: the raw EVENT_PUT/EVENT_DEL entries for its id, in
// time order — who changed it, when, and to what. The fold keeps only the final state,
// so this reads the raw log. Idempotent duplicates share an id so they collapse.
export async function getEventHistory(
  calId: string,
  eventId: string,
): Promise<{ author: string; at: number; action: "created" | "edited" | "deleted"; payload: any }[]> {
  const seen = new Set<string>();
  const entries = (await store.getLog(calId))
    .filter((e) => (e.type === ET.EVENT_PUT || e.type === ET.EVENT_DEL) && (e.payload as any)?.id === eventId)
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.hlc.wall - b.hlc.wall || (a.hlc.dev < b.hlc.dev ? -1 : a.hlc.dev > b.hlc.dev ? 1 : 0));
  return entries.map((e, i) => ({
    author: e.dev,
    at: e.hlc.wall,
    action: e.type === ET.EVENT_DEL ? "deleted" : i === 0 ? "created" : "edited",
    payload: e.payload,
  }));
}

// Roles (#3): grant/revoke a member by their device id (owner/admin only — the fold
// enforces it). role "remove" clears the grant. Writes a member.set event.
export async function setMemberRole(calId: string, member: string, role: "admin" | "viewer" | "remove"): Promise<void> {
  await publishAndApply(calId, await mkEvent(ET.MEMBER_SET, { member, role }));
  notifyChange();
}

// Device-LOCAL alias (never synced): overrides the display name on THIS phone while the
// official cal.meta name is preserved for everyone. Empty alias clears it.
export async function getAlias(calId: string): Promise<string> {
  try { return (await SecureStore.getItemAsync("scala-alias-" + calId)) || ""; } catch { return ""; }
}
export async function setAlias(calId: string, alias: string): Promise<void> {
  try {
    if (alias.trim()) await SecureStore.setItemAsync("scala-alias-" + calId, alias.trim());
    else await SecureStore.deleteItemAsync("scala-alias-" + calId);
  } catch { /* ignore */ }
  notifyChange();
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
