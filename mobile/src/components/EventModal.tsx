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
}

export function EventModal({
  visible, initial, onSave, onDelete, onClose,
}: {
  visible: boolean;
  initial: EventDraft;
  onSave: (d: EventDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [start, setStart] = useState(new Date(initial.startTime));
  const [end, setEnd] = useState(new Date(initial.endTime));
  const [desc, setDesc] = useState(initial.description || "");
  const [pick, setPick] = useState<null | { which: "start" | "end"; mode: "date" | "time" }>(null);

  // Re-seed when opened for a different event/day.
  React.useEffect(() => {
    if (visible) {
      setTitle(initial.title);
      setStart(new Date(initial.startTime));
      setEnd(new Date(initial.endTime));
      setDesc(initial.description || "");
    }
  }, [visible, initial]);

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
    onSave({ id: initial.id, title: title.trim(), startTime: start.getTime(), endTime: end.getTime(), description: desc.trim() || undefined });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.h}>{initial.id ? "Edit event" : "New event"}</Text>

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
});
