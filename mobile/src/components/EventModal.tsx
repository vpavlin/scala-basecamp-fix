// Event editor — create or edit an event on a calendar. Title, date, start/end
// time, description, with native date/time pickers. Delete when editing.
import React, { useState } from "react";
import {
  Modal, View, Text, TextInput, Pressable, ScrollView, Platform, StyleSheet,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { CalEvent } from "../lib/store";

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
  fields?: Record<string, any>; // #8: custom schema field values
}

export interface CalOption { id: string; name: string; color: string }
export interface FieldDef { key: string; label?: string; type?: string; options?: string[] }
export interface HistoryEntry { author: string; at: number; action: string; payload: any }

export function EventModal({
  visible, initial, calendars, calendarId, onPickCalendar, canPickCalendar, onSave, onDelete, onClose,
  schema = [], loadHistory,
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
}) {
  const [title, setTitle] = useState(initial.title);
  const [start, setStart] = useState(new Date(initial.startTime));
  const [end, setEnd] = useState(new Date(initial.endTime));
  const [desc, setDesc] = useState(initial.description || "");
  const [fields, setFields] = useState<Record<string, any>>(initial.fields || {});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pick, setPick] = useState<null | { which: "start" | "end"; mode: "date" | "time" }>(null);

  // Re-seed when opened for a different event/day.
  React.useEffect(() => {
    if (visible) {
      setTitle(initial.title);
      setStart(new Date(initial.startTime));
      setEnd(new Date(initial.endTime));
      setDesc(initial.description || "");
      setFields(initial.fields || {});
      setHistory([]);
      if (initial.id && loadHistory) loadHistory().then(setHistory).catch(() => setHistory([]));
    }
  }, [visible, initial]);
  const setField = (k: string, v: any) => setFields((f) => ({ ...f, [k]: v }));
  const fmtWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const shortDev = (d: string) => (d ? d.replace(/^scala-/, "").slice(0, 6) : "?");

  const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const onPicked = (e: unknown, date?: Date) => {
    const cur = pick;
    setPick(null);
    if (!date || !cur) return;
    const target = cur.which === "start" ? start : end;
    const merged = new Date(target);
    if (cur.mode === "date") { merged.setFullYear(date.getFullYear(), date.getMonth(), date.getDate()); }
    else { merged.setHours(date.getHours(), date.getMinutes(), 0, 0); }
    if (cur.which === "start") {
      setStart(merged);
      if (merged.getTime() > end.getTime()) setEnd(new Date(merged.getTime() + 3600_000));
    } else {
      setEnd(merged);
    }
  };

  const save = () => {
    if (!title.trim()) return;
    onSave({
      id: initial.id, title: title.trim(), startTime: start.getTime(), endTime: end.getTime(),
      description: desc.trim() || undefined,
      fields: schema.length ? fields : undefined,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.h}>{initial.id ? "Edit event" : "New event"}</Text>

            <Text style={s.label}>Calendar</Text>
            <View style={s.calRow}>
              {calendars.map((c) => {
                const on = c.id === calendarId;
                return (
                  <Pressable
                    key={c.id}
                    disabled={!canPickCalendar}
                    onPress={() => onPickCalendar(c.id)}
                    style={[s.calChip, on && s.calChipOn, !canPickCalendar && !on && { opacity: 0.4 }]}
                  >
                    <View style={[s.calDot, { backgroundColor: c.color }]} />
                    <Text style={[s.calChipT, on && { color: C.text }]}>{c.name}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={s.label}>Title</Text>
            <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Event title" placeholderTextColor={C.sub} autoFocus={!initial.id} />

            <Text style={s.label}>Starts</Text>
            <View style={s.row}>
              <Pressable style={s.pill} onPress={() => setPick({ which: "start", mode: "date" })}><Text style={s.pillT}>{fmtDate(start)}</Text></Pressable>
              <Pressable style={s.pill} onPress={() => setPick({ which: "start", mode: "time" })}><Text style={s.pillT}>{fmtTime(start)}</Text></Pressable>
            </View>

            <Text style={s.label}>Ends</Text>
            <View style={s.row}>
              <Pressable style={s.pill} onPress={() => setPick({ which: "end", mode: "date" })}><Text style={s.pillT}>{fmtDate(end)}</Text></Pressable>
              <Pressable style={s.pill} onPress={() => setPick({ which: "end", mode: "time" })}><Text style={s.pillT}>{fmtTime(end)}</Text></Pressable>
            </View>

            <Text style={s.label}>Notes</Text>
            <TextInput style={[s.input, { height: 72 }]} value={desc} onChangeText={setDesc} placeholder="Optional" placeholderTextColor={C.sub} multiline />

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
                value={pick.which === "start" ? start : end}
                mode={pick.mode}
                is24Hour
                onChange={onPicked}
                display={Platform.OS === "ios" ? "spinner" : "default"}
              />
            )}

            <Pressable style={[s.btn, { backgroundColor: C.accent }]} onPress={save}>
              <Text style={[s.btnT, { color: C.bg }]}>{initial.id ? "Save" : "Create"}</Text>
            </Pressable>
            {initial.id && onDelete && (
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
      </View>
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
  pill: { flex: 1, backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingVertical: 11, alignItems: "center" },
  pillT: { color: C.text, fontSize: 14, fontWeight: "600" },
  btn: { borderRadius: 10, paddingVertical: 13, alignItems: "center", marginTop: 12 },
  btnT: { fontSize: 15, fontWeight: "700" },
  calRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  calChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.bg, borderRadius: 999, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 7 },
  calChipOn: { borderColor: C.primary, backgroundColor: C.surface },
  calChipT: { color: C.sub, fontSize: 13, fontWeight: "600" },
  calDot: { width: 10, height: 10, borderRadius: 5 },
  histLine: { color: C.sub, fontSize: 12, marginTop: 4 },
});
