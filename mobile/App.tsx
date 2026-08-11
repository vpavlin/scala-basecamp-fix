// Scala mobile — minimal calendar peer over Logos Delivery (SDS channels).
// SCAFFOLD: agenda list of the shared calendars, join-by-invite, add-event.
// The full month/week/day UI (from the desktop QML) is the next iteration; this
// proves the sync spine end-to-end against the desktop.
import React, { useEffect, useState, useCallback } from "react";
import {
  SafeAreaView, ScrollView, View, Text, TextInput, Pressable, Switch, StyleSheet, Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { store, Calendar, CalEvent } from "./src/lib/store";
import {
  onChange, startSyncing, joinFromInvite, createEvent, createCalendar,
  buildInvite, getSharedNode, setSharedNode,
} from "./src/lib/calendar";
import { deliveryAvailable } from "./src/lib/scala-sync";

const C = {
  bg: "#1e1e2e", surface: "#2a2a3c", text: "#cdd6f4", sub: "#9399b2",
  primary: "#89b4fa", border: "#313244", accent: "#a6e3a1",
};

export default function App() {
  const [cals, setCals] = useState<Calendar[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [status, setStatus] = useState("starting");
  const [invite, setInvite] = useState("");
  const [title, setTitle] = useState("");
  const [newCalName, setNewCalName] = useState("");
  const [lastInvite, setLastInvite] = useState("");
  const [shared, setShared] = useState(false);

  const refresh = useCallback(async () => {
    setCals(await store.listCalendars());
    setEvents((await store.listEvents()).filter((e) => !e.deleted).sort((a, b) => a.startTime - b.startTime));
  }, []);

  useEffect(() => {
    refresh();
    const off = onChange(refresh);
    (async () => {
      setShared(await getSharedNode());
      if (!deliveryAvailable()) { setStatus("no delivery node in this build"); return; }
      try { await startSyncing(undefined, (s) => setStatus(s)); }
      catch (e) { setStatus("sync error: " + (e instanceof Error ? e.message : String(e))); }
    })();
    return off;
  }, [refresh]);

  const doCreate = async () => {
    const cal = await createCalendar(newCalName || "My calendar");
    setNewCalName("");
    const link = buildInvite(cal);
    setLastInvite(link);
    Alert.alert("Calendar created", `"${cal.name}" — share the invite below to sync it with others.`);
  };

  const toggleShared = async (v: boolean) => {
    setShared(v);
    await setSharedNode(v);
    Alert.alert(
      v ? "Shared node ON" : "Shared node OFF",
      v
        ? "Scala will route through the device-wide Logos Delivery app. Install it and approve Scala once. Restart Scala to apply."
        : "Scala will use its own embedded node. Restart Scala to apply.",
    );
  };

  const doJoin = async () => {
    const cal = await joinFromInvite(invite.trim());
    if (!cal) { Alert.alert("Bad invite", "Expected a scala://join?cal=…&key=… link"); return; }
    setInvite("");
    await startSyncing(undefined, (s) => setStatus(s)); // (re)join the new topic, honor pref
    Alert.alert("Joined", `Syncing "${cal.name}"`);
  };

  const doAdd = async () => {
    const cal = cals.find((c) => c.encryptionKey);
    if (!cal) { Alert.alert("No shared calendar", "Join one via an invite first."); return; }
    if (!title.trim()) return;
    const now = Date.now();
    await createEvent(cal.id, { title: title.trim(), startTime: now, endTime: now + 3600_000 });
    setTitle("");
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>Scala</Text>
        <Text style={s.status}>{status} · {cals.length} calendar(s)</Text>

        <View style={s.card}>
          <View style={s.rowBetween}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Text style={s.label}>Shared Logos Delivery node</Text>
              <Text style={s.sub}>Route through the device-wide node (approve once). Restart to apply.</Text>
            </View>
            <Switch value={shared} onValueChange={toggleShared} trackColor={{ true: C.primary, false: C.border }} thumbColor="#fff" />
          </View>
        </View>

        <View style={s.card}>
          <Text style={s.label}>Create a calendar</Text>
          <TextInput
            style={s.input} value={newCalName} onChangeText={setNewCalName}
            placeholder="Calendar name" placeholderTextColor={C.sub}
          />
          <Pressable style={s.btn} onPress={doCreate}><Text style={s.btnT}>Create</Text></Pressable>
          {!!lastInvite && (
            <View style={{ marginTop: 10 }}>
              <Text style={s.sub}>Share this invite (long-press to copy):</Text>
              <TextInput style={[s.input, { marginTop: 6 }]} value={lastInvite} editable={false} multiline selectTextOnFocus />
            </View>
          )}
        </View>

        <View style={s.card}>
          <Text style={s.label}>Join a shared calendar</Text>
          <TextInput
            style={s.input} value={invite} onChangeText={setInvite}
            placeholder="scala://join?cal=…&key=…" placeholderTextColor={C.sub} autoCapitalize="none"
          />
          <Pressable style={s.btn} onPress={doJoin}><Text style={s.btnT}>Join</Text></Pressable>
        </View>

        <View style={s.card}>
          <Text style={s.label}>Quick add event (to first shared calendar)</Text>
          <TextInput
            style={s.input} value={title} onChangeText={setTitle}
            placeholder="Event title" placeholderTextColor={C.sub}
          />
          <Pressable style={[s.btn, { backgroundColor: C.accent }]} onPress={doAdd}>
            <Text style={[s.btnT, { color: "#1e1e2e" }]}>Add now</Text>
          </Pressable>
        </View>

        <Text style={s.label}>Agenda</Text>
        {events.length === 0 ? (
          <Text style={s.sub}>No events yet.</Text>
        ) : (
          events.map((item) => {
            const cal = cals.find((c) => c.id === item.calendarId);
            return (
              <View style={s.event} key={item.id}>
                <View style={[s.dot, { backgroundColor: cal?.color || C.primary }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.evTitle}>{item.title}</Text>
                  <Text style={s.sub}>{new Date(item.startTime).toLocaleString()}</Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 16 },
  h1: { color: C.text, fontSize: 28, fontWeight: "700", marginTop: 8 },
  status: { color: C.sub, fontSize: 12, marginBottom: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  card: { backgroundColor: C.surface, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  label: { color: C.text, fontSize: 13, fontWeight: "600", marginBottom: 6 },
  input: { backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  btn: { backgroundColor: C.primary, borderRadius: 8, paddingVertical: 11, alignItems: "center" },
  btnT: { color: "#1e1e2e", fontWeight: "700" },
  sub: { color: C.sub, fontSize: 12 },
  event: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.surface, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  dot: { width: 12, height: 12, borderRadius: 6 },
  evTitle: { color: C.text, fontSize: 15, fontWeight: "600" },
});
