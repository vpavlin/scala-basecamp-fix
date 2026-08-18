// Event editor — create or edit an event on a calendar. Title, date, start/end
// time, description, with native date/time pickers. Delete when editing.
import React, { useState } from "react";
import {
  Modal, View, Text, TextInput, Pressable, ScrollView, Platform, StyleSheet, KeyboardAvoidingView,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { CalEvent } from "../lib/store";
import { Recur, Freq, recurLabel } from "../lib/recur";

const FREQS: { key: Freq | "none"; label: string }[] = [
  { key: "none", label: "Once" }, { key: "daily", label: "Daily" }, { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" }, { key: "yearly", label: "Yearly" },
];
const REMINDERS: { min: number; label: string }[] = [
  { min: 0, label: "None" }, { min: 10, label: "10 min" }, { min: 30, label: "30 min" },
  { min: 60, label: "1 hr" }, { min: 1440, label: "1 day" },
];

const C = {
  bg: "#1e1e2e", surface: "#2a2a3c", text: "#cdd6f4", sub: "#9399b2",
  primary: "#89b4fa", border: "#313244", danger: "#f38ba8", accent: "#a6e3a1",
};

export interface EventDraft {
  id?: string;
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
  location?: string;
  url?: string;
  allDay?: boolean;
  reminderMin?: number;
  recur?: Recur;
  fields?: Record<string, any>; // #8: custom schema field values
}

export interface CalOption { id: string; name: string; color: string }
export interface FieldDef { key: string; label?: string; type?: string; options?: string[] }
export interface HistoryEntry { author: string; at: number; action: string; payload: any }

export function EventModal({
  visible, initial, calendars, calendarId, onPickCalendar, canPickCalendar, onSave, onDelete, onClose,
  schema = [], loadHistory, canEdit = true, readonlyReason,
}: {
  visible: boolean;
  initial: EventDraft;
  calendars: CalOption[];        // writable calendars to choose from
  calendarId: string;            // currently selected target
  onPickCalendar: (id: string) => void;
  canPickCalendar: boolean;      // false when editing (can't move an event)
  onSave: (d: EventDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
  schema?: FieldDef[];           // #8: the calendar's custom-field definitions (empty = none)
  loadHistory?: () => Promise<HistoryEntry[]>; // #4: async edit-history loader (when editing)
  canEdit?: boolean;             // false = viewer on a role-managed calendar → read-only
  readonlyReason?: string;       // specific "why you can't edit" copy (owner/identity mismatch, closed, viewer)
}) {
  const [title, setTitle] = useState(initial.title);
  const [start, setStart] = useState(new Date(initial.startTime));
  const [end, setEnd] = useState(new Date(initial.endTime));
  const [desc, setDesc] = useState(initial.description || "");
  const [location, setLocation] = useState(initial.location || "");
  const [url, setUrl] = useState(initial.url || "");
  const [allDay, setAllDay] = useState(!!initial.allDay);
  const [tz, setTz] = useState<"local" | "utc">("local"); // enter start/end times in local or UTC
  const [reminderMin, setReminderMin] = useState(initial.reminderMin ?? 10);
  const [recur, setRecur] = useState<Recur | undefined>(initial.recur);
  const [fields, setFields] = useState<Record<string, any>>(initial.fields || {});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pick, setPick] = useState<null | { which: "start" | "end" | "until"; mode: "date" | "time" }>(null);
  const [calOpen, setCalOpen] = useState(false); // #6: select-box dropdown open?
  const selCal = calendars.find((c) => c.id === calendarId);

  // Re-seed when opened for a different event/day.
  React.useEffect(() => {
    if (visible) {
      setTitle(initial.title);
      setStart(new Date(initial.startTime));
      setEnd(new Date(initial.endTime));
      setDesc(initial.description || "");
      setLocation(initial.location || "");
      setUrl(initial.url || "");
      setAllDay(!!initial.allDay);
      setReminderMin(initial.reminderMin ?? 10);
      setRecur(initial.recur);
      setFields(initial.fields || {});
      setHistory([]);
      if (initial.id && loadHistory) loadHistory().then(setHistory).catch(() => setHistory([]));
    }
  }, [visible, initial]);
  // Recurrence helpers — the freq chip row + interval + until.
  const setFreq = (f: Freq | "none") =>
    setRecur(f === "none" ? undefined : { freq: f, interval: recur?.interval || 1, until: recur?.until });
  const setInterval = (n: number) => setRecur((r) => (r ? { ...r, interval: Math.max(1, n) } : r));
  const setField = (k: string, v: any) => setFields((f) => ({ ...f, [k]: v }));
  const fmtWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const shortDev = (d: string) => (d ? d.replace(/^scala-/, "").slice(0, 6) : "?");

  // Enter start/end wall-clock in Local or UTC. An event is still an absolute instant; the toggle
  // only changes which wall-clock the pickers show/parse. Manual UTC formatting is Hermes-safe.
  const pad = (n: number) => String(n).padStart(2, "0");
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (d: Date) => tz === "utc"
    ? `${WD[d.getUTCDay()]}, ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const fmtTime = (d: Date) => tz === "utc"
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  // Native picker renders device-local; in UTC mode seed it shifted so its local face shows the
  // instant's UTC wall-clock (and onPicked reads it back via setUTC*).
  const pickerValue = (): Date => {
    const t = pick?.which === "start" ? start : end;
    return tz === "utc" && pick?.which !== "until" ? new Date(t.getTime() + t.getTimezoneOffset() * 60000) : t;
  };

  const onPicked = (e: unknown, date?: Date) => {
    const cur = pick;
    setPick(null);
    if (!date || !cur) return;
    if (cur.which === "until") {
      const u = new Date(date); u.setHours(23, 59, 0, 0);
      setRecur((r) => (r ? { ...r, until: u.getTime() } : r));
      return;
    }
    const target = cur.which === "start" ? start : end;
    const merged = new Date(target);
    const utc = tz === "utc";
    if (cur.mode === "date") {
      if (utc) merged.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
      else merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    } else {
      if (utc) merged.setUTCHours(date.getHours(), date.getMinutes(), 0, 0);
      else merged.setHours(date.getHours(), date.getMinutes(), 0, 0);
    }
    if (cur.which === "start") {
      setStart(merged);
      if (merged.getTime() > end.getTime()) setEnd(new Date(merged.getTime() + 3600_000));
    } else {
      setEnd(merged);
    }
  };

  const save = () => {
    if (!title.trim()) return;
    let st = start.getTime(), en = end.getTime();
    if (allDay) {
      const s0 = new Date(start); s0.setHours(0, 0, 0, 0);
      const e0 = new Date(end); e0.setHours(23, 59, 0, 0);
      st = s0.getTime(); en = e0.getTime();
    }
    onSave({
      id: initial.id, title: title.trim(), startTime: st, endTime: en,
      description: desc.trim() || undefined,
      location: location.trim() || undefined,
      url: url.trim() || undefined,
      allDay: allDay || undefined,
      reminderMin,
      recur,
      fields: schema.length ? fields : undefined,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.h}>{initial.id ? "Edit event" : "New event"}</Text>

            {/* #6: calendar picker as a select box (dropdown) — handles long names. */}
            <Text style={s.label}>Calendar</Text>
            {canPickCalendar ? (
              <>
                <Pressable style={s.select} onPress={() => setCalOpen((o) => !o)}>
                  <View style={[s.calDot, { backgroundColor: selCal?.color || C.border }]} />
                  <Text style={s.selectT} numberOfLines={1}>{selCal?.name || "Select a calendar"}</Text>
                  <Text style={s.caret}>{calOpen ? "▲" : "▼"}</Text>
                </Pressable>
                {calOpen && (
                  <View style={s.selectList}>
                    {calendars.map((c) => (
                      <Pressable key={c.id} style={s.selectItem} onPress={() => { onPickCalendar(c.id); setCalOpen(false); }}>
                        <View style={[s.calDot, { backgroundColor: c.color }]} />
                        <Text style={[s.selectItemT, c.id === calendarId && { color: C.text, fontWeight: "700" }]} numberOfLines={1}>{c.name}</Text>
                        {c.id === calendarId && <Text style={{ color: C.primary }}>✓</Text>}
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            ) : (
              <View style={s.select}>
                <View style={[s.calDot, { backgroundColor: selCal?.color || C.border }]} />
                <Text style={s.selectT} numberOfLines={1}>{selCal?.name || ""}</Text>
              </View>
            )}

            <Text style={s.label}>Title</Text>
            <TextInput style={s.input} value={title} editable={canEdit} onChangeText={setTitle} placeholder="Event title" placeholderTextColor={C.sub} autoFocus={!initial.id} />

            <Pressable style={s.toggleRow} onPress={() => setAllDay((v) => !v)}>
              <Text style={s.label}>All-day</Text>
              <View style={[s.check, allDay && s.checkOn]}>{allDay && <Text style={{ color: C.bg, fontWeight: "800" }}>✓</Text>}</View>
            </Pressable>

            {!allDay && (
              <View style={s.tzRow}>
                <Text style={[s.label, { marginBottom: 0 }]}>Enter times in</Text>
                {(["local", "utc"] as const).map((z) => (
                  <Pressable key={z} onPress={() => setTz(z)} style={[s.tzChip, tz === z && s.tzChipOn]}>
                    <Text style={[s.tzChipT, tz === z && { color: C.bg }]}>{z === "local" ? "Local" : "UTC"}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={s.label}>Starts</Text>
            <View style={s.row}>
              <Pressable style={s.pill} onPress={() => setPick({ which: "start", mode: "date" })}><Text style={s.pillT}>{fmtDate(start)}</Text></Pressable>
              {!allDay && <Pressable style={s.pill} onPress={() => setPick({ which: "start", mode: "time" })}><Text style={s.pillT}>{fmtTime(start)}</Text></Pressable>}
            </View>

            <Text style={s.label}>Ends</Text>
            <View style={s.row}>
              <Pressable style={s.pill} onPress={() => setPick({ which: "end", mode: "date" })}><Text style={s.pillT}>{fmtDate(end)}</Text></Pressable>
              {!allDay && <Pressable style={s.pill} onPress={() => setPick({ which: "end", mode: "time" })}><Text style={s.pillT}>{fmtTime(end)}</Text></Pressable>}
            </View>

            <Text style={s.label}>Location</Text>
            <TextInput style={s.input} value={location} editable={canEdit} onChangeText={setLocation} placeholder="Where" placeholderTextColor={C.sub} />

            <Text style={s.label}>Meeting link</Text>
            <TextInput style={s.input} value={url} editable={canEdit} onChangeText={setUrl} placeholder="https://…" placeholderTextColor={C.sub} autoCapitalize="none" keyboardType="url" />

            <Text style={s.label}>Reminder</Text>
            <View style={s.calRow}>
              {REMINDERS.map((r) => (
                <Pressable key={r.min} onPress={() => setReminderMin(r.min)} style={[s.calChip, reminderMin === r.min && s.calChipOn]}>
                  <Text style={[s.calChipT, reminderMin === r.min && { color: C.text }]}>{r.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={s.label}>Repeat</Text>
            <View style={s.calRow}>
              {FREQS.map((f) => {
                const on = (recur?.freq || "none") === f.key;
                return (
                  <Pressable key={f.key} onPress={() => setFreq(f.key)} style={[s.calChip, on && s.calChipOn]}>
                    <Text style={[s.calChipT, on && { color: C.text }]}>{f.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {recur && (
              <>
                <View style={[s.row, { marginTop: 8, alignItems: "center" }]}>
                  <Text style={[s.calChipT, { color: C.sub }]}>Every</Text>
                  <TextInput
                    style={[s.input, { width: 60, textAlign: "center" }]}
                    value={String(recur.interval || 1)}
                    onChangeText={(t) => setInterval(Number(t.replace(/[^0-9]/g, "")) || 1)}
                    keyboardType="numeric"
                  />
                  <Text style={[s.calChipT, { color: C.sub, flex: 1 }]}>{recurLabel(recur)}</Text>
                </View>
                <View style={[s.row, { marginTop: 8, alignItems: "center" }]}>
                  <Text style={[s.calChipT, { color: C.sub }]}>Until</Text>
                  <Pressable style={[s.pill, { flex: 1 }]} onPress={() => setPick({ which: "until", mode: "date" })}>
                    <Text style={s.pillT}>{recur.until ? new Date(recur.until).toLocaleDateString() : "No end date"}</Text>
                  </Pressable>
                  {recur.until && <Pressable onPress={() => setRecur((r) => (r ? { ...r, until: undefined } : r))} hitSlop={8}><Text style={{ color: C.danger, fontSize: 18 }}>×</Text></Pressable>}
                </View>
              </>
            )}

            <Text style={s.label}>Notes</Text>
            <TextInput style={[s.input, { height: 72 }]} value={desc} editable={canEdit} onChangeText={setDesc} placeholder="Optional" placeholderTextColor={C.sub} multiline />

            {/* #8: custom fields, driven by the calendar's schema. Nothing shows when empty. */}
            {schema.map((f) => (
              <View key={f.key}>
                <Text style={s.label}>{f.label || f.key}</Text>
                {f.type === "bool" ? (
                  <Pressable onPress={() => setField(f.key, !fields[f.key])} style={[s.input, { flexDirection: "row", alignItems: "center" }]}>
                    <Text style={{ color: C.text }}>{fields[f.key] ? "✓ Yes" : "No"}</Text>
                  </Pressable>
                ) : f.type === "enum" && Array.isArray(f.options) ? (
                  <View style={s.calRow}>
                    {f.options.map((o) => (
                      <Pressable key={o} onPress={() => setField(f.key, o)} style={[s.calChip, fields[f.key] === o && s.calChipOn]}>
                        <Text style={[s.calChipT, fields[f.key] === o && { color: C.text }]}>{o}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <TextInput
                    style={s.input}
                    value={fields[f.key] != null ? String(fields[f.key]) : ""}
                    onChangeText={(t) => setField(f.key, f.type === "number" ? (Number(t) || 0) : t)}
                    keyboardType={f.type === "number" ? "numeric" : "default"}
                    autoCapitalize={f.type === "url" ? "none" : "sentences"}
                    placeholder={f.type || "text"}
                    placeholderTextColor={C.sub}
                  />
                )}
              </View>
            ))}

            {pick && (
              <DateTimePicker
                value={pickerValue()}
                mode={pick.mode}
                is24Hour
                onChange={onPicked}
                display={Platform.OS === "ios" ? "spinner" : "default"}
              />
            )}

            {!canEdit && (
              <View style={{ marginTop: 14, padding: 10, borderRadius: 8, backgroundColor: "#3a2f1a", borderWidth: 1, borderColor: "#f9e2af" }}>
                <Text style={{ color: "#f9e2af", fontSize: 12, fontWeight: "700" }}>🔒 Read-only</Text>
                <Text style={{ color: "#f9e2af", fontSize: 12, marginTop: 3 }}>
                  {readonlyReason || (initial.id ? "You can only edit events you created (editors can edit any)." : "You can't add events to this calendar.")}
                </Text>
              </View>
            )}
            {canEdit && (
              <Pressable style={[s.btn, { backgroundColor: C.accent }]} onPress={save}>
                <Text style={[s.btnT, { color: C.bg }]}>{initial.id ? "Save" : "Create"}</Text>
              </Pressable>
            )}
            {initial.id && onDelete && canEdit && (
              <Pressable style={[s.btn, { backgroundColor: "transparent" }]} onPress={onDelete}>
                <Text style={[s.btnT, { color: C.danger }]}>Delete event</Text>
              </Pressable>
            )}
            {/* #4: edit history — who created/edited/deleted this event, and when. */}
            {initial.id && history.length > 0 && (
              <View style={{ marginTop: 18 }}>
                <Text style={s.label}>History</Text>
                {history.map((h, i) => (
                  <Text key={i} style={s.histLine}>· {h.action} by {shortDev(h.author)} — {fmtWhen(h.at)}</Text>
                ))}
              </View>
            )}

            <Pressable style={[s.btn, { backgroundColor: "transparent" }]} onPress={onClose}>
              <Text style={[s.btnT, { color: C.sub }]}>Cancel</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "88%" },
  h: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 12 },
  label: { color: C.sub, fontSize: 12, fontWeight: "600", marginTop: 12, marginBottom: 6, textTransform: "uppercase" },
  input: { backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 10 },
  row: { flexDirection: "row", gap: 8 },
  tzRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  tzChip: { paddingVertical: 5, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  tzChipOn: { backgroundColor: C.primary, borderColor: C.primary },
  tzChipT: { color: C.sub, fontSize: 12.5, fontWeight: "700" },
  pill: { flex: 1, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingVertical: 11, alignItems: "center" },
  pillT: { color: C.text, fontSize: 14, fontWeight: "600" },
  btn: { borderRadius: 10, paddingVertical: 13, alignItems: "center", marginTop: 12 },
  btnT: { fontSize: 15, fontWeight: "700" },
  select: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 12 },
  selectT: { flex: 1, color: C.text, fontSize: 14, fontWeight: "600" },
  caret: { color: C.sub, fontSize: 12 },
  selectList: { marginTop: 4, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: "hidden" },
  selectItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  selectItemT: { flex: 1, color: C.sub, fontSize: 14 },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  check: { width: 26, height: 26, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", marginTop: 10 },
  checkOn: { backgroundColor: C.accent, borderColor: C.accent },
  calRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  calChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.bg, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 7 },
  calChipOn: { borderColor: C.primary, backgroundColor: C.surface },
  calChipT: { color: C.sub, fontSize: 13, fontWeight: "600" },
  calDot: { width: 10, height: 10, borderRadius: 5 },
  histLine: { color: C.sub, fontSize: 12, marginTop: 4 },
});
