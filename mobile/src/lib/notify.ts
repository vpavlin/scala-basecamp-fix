// Local event reminders (#1). Purely on-device scheduled notifications — no server,
// no push tokens — which is exactly right for a local-first calendar: the events
// already live on the phone, so the phone can remind you about them offline.
//
// We fire one reminder LEAD_MS before each future event's start (or at start if it's
// sooner than that). On every data refresh we reconcile: cancel all and reschedule
// the current future set. A calendar rarely holds enough events for that churn to
// matter, and it keeps the schedule exactly in step with edits/deletes/synced-in events.
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { CalEvent } from "./store";

const LEAD_MS = 10 * 60 * 1000; // remind 10 minutes before start
const CHANNEL = "events";

// Foreground presentation (newer expo-notifications uses banner/list, not the old alert).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let granted = false;

export async function ensureNotifyPermission(): Promise<boolean> {
  try {
    let status = (await Notifications.getPermissionsAsync()).status;
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    granted = status === "granted";
    if (granted && Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: "Event reminders",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
  } catch {
    granted = false;
  }
  return granted;
}

let timer: ReturnType<typeof setTimeout> | null = null;
// Debounce bursts of refreshes (sync can fire many onChange in a row), then reconcile.
export function scheduleReminders(events: CalEvent[]): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void reconcile(events), 500);
}

async function reconcile(events: CalEvent[]): Promise<void> {
  if (!granted) return;
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    return;
  }
  const now = Date.now();
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  for (const e of events) {
    if (!e.startTime || e.startTime <= now || e.deleted) continue;
    const fireAt = Math.max(e.startTime - LEAD_MS, now + 5000);
    if (fireAt <= now) continue;
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title: e.title || "Event", body: `Starts at ${fmt(e.startTime)}` },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(fireAt),
          channelId: CHANNEL,
        },
      });
    } catch {
      /* skip a single bad event */
    }
  }
}
