import { NativeModules, Platform } from "react-native";

// Bridge to the native home-screen agenda widget (Android). The app pushes the next few upcoming
// events; the native side persists them to SharedPreferences and refreshes every widget instance.
// Purely local — no node/network — so the widget reflects offline authoring immediately.
// A day-divider header, or an event row. The native factory renders the two as distinct view types.
export type WidgetItem =
  | { type: "header"; label: string }
  | { type: "event"; title: string; timeLabel: string; calendar: string; color: string /* #RRGGBB */ };

const mod: { updateAgenda?: (json: string) => Promise<number> } | undefined =
  (NativeModules as any).ScalaWidget;

export async function updateWidgetAgenda(items: WidgetItem[]): Promise<void> {
  if (Platform.OS !== "android" || !mod?.updateAgenda) return; // no-op where the widget doesn't exist
  try {
    await mod.updateAgenda(JSON.stringify(items));
  } catch {
    // Widget update is best-effort; never let it disrupt the app.
  }
}
