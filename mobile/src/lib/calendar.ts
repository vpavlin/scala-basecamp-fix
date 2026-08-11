// App logic: bridges the local store and the sync wire. Applies inbound
// SyncMessages to the store and publishes local edits. Also parses/builds the
// `scala://` invite links the desktop uses to share a calendar's key.
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { store, Calendar, CalEvent } from "./store";
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

// ── scala:// invite links (matches the desktop generateShareLink/parseShareLink) ─
// Form: scala://join?cal=<calendarId>&key=<encryptionKey>&name=<name>
export function parseInvite(link: string): { calendarId: string; key: string; name?: string } | null {
  try {
    const q = link.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const calendarId = params.get("cal") || "";
    const key = params.get("key") || "";
    if (!calendarId || !key) return null;
    return { calendarId, key, name: params.get("name") || undefined };
  } catch {
    return null;
  }
}
export function buildInvite(cal: Calendar): string {
  const p = new URLSearchParams({ cal: cal.id, key: cal.encryptionKey || "", name: cal.name });
  return `scala://join?${p.toString()}`;
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

/** Bring sync up on every shared calendar we hold a key for. */
export async function startSyncing(shared: boolean, onStatus?: (s: string) => void): Promise<void> {
  const cals = await store.listCalendars();
  await sync.startSync({
    deviceId: await getDeviceId(),
    calendars: cals
      .filter((c) => c.encryptionKey)
      .map((c) => ({ id: c.id, encryptionKey: c.encryptionKey as string })),
    shared,
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
