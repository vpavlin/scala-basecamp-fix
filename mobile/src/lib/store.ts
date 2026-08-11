// Local calendar/event store (AsyncStorage). The mobile app is a full peer: it
// holds its own copy of calendars + events, applies inbound SyncMessages, and
// publishes its own edits. Mirrors the shape the desktop core stores/sends so
// the JSON payloads interoperate.
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Calendar {
  id: string;
  name: string;
  color: string;
  creatorId?: string;
  isShared?: boolean;
  encryptionKey?: string; // present iff shared/joined on this device
  updatedAt?: number;
}

export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  startTime: number; // ms epoch
  endTime: number;   // ms epoch
  description?: string;
  location?: string;
  updatedAt?: number;
  deleted?: boolean; // tombstone
}

const K_CALS = "scala.calendars";
const K_EVENTS = "scala.events";

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const s = await AsyncStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}
async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  listCalendars: () => readJson<Calendar[]>(K_CALS, []),
  listEvents: () => readJson<CalEvent[]>(K_EVENTS, []),

  async saveCalendar(cal: Calendar): Promise<void> {
    const cals = await readJson<Calendar[]>(K_CALS, []);
    const i = cals.findIndex((c) => c.id === cal.id);
    // Last-write-wins by updatedAt.
    if (i >= 0) {
      if ((cal.updatedAt ?? 0) < (cals[i].updatedAt ?? 0)) return;
      cals[i] = { ...cals[i], ...cal };
    } else {
      cals.push(cal);
    }
    await writeJson(K_CALS, cals);
  },

  async saveEvent(ev: CalEvent): Promise<void> {
    const events = await readJson<CalEvent[]>(K_EVENTS, []);
    const i = events.findIndex((e) => e.id === ev.id);
    if (i >= 0) {
      if ((ev.updatedAt ?? 0) < (events[i].updatedAt ?? 0)) return; // stale
      events[i] = { ...events[i], ...ev };
    } else {
      events.push(ev);
    }
    await writeJson(K_EVENTS, events);
  },

  async eventsFor(calendarId: string): Promise<CalEvent[]> {
    const events = await readJson<CalEvent[]>(K_EVENTS, []);
    return events.filter((e) => e.calendarId === calendarId && !e.deleted);
  },
};

// Deterministic calendar color from its id — MUST match the desktop
// (CalendarView.qml calColor): same palette + hash, so a calendar shows the same
// color on every device regardless of any stored color.
const CAL_PALETTE = ["#a6e3a1","#89b4fa","#f9e2af","#f38ba8","#cba6f7","#94e2d5","#fab387","#74c7ec","#eba0ac","#b4befe"];
export function colorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CAL_PALETTE[h % CAL_PALETTE.length];
}
