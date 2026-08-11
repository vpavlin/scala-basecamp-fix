// Scala mobile — shared calendar peer over Logos Delivery (SDS channels).
// Month grid + day detail + event editor; calendars live in a left drawer.
import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, TextInput, Pressable, Switch, ScrollView, StyleSheet, Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { store, Calendar, CalEvent } from "./src/lib/store";
import {
  onChange, startSyncing, joinFromInvite, createEvent, updateEvent, deleteEvent,
  createCalendar, buildInvite, getSharedNode, setSharedNode,
} from "./src/lib/calendar";
import { deliveryAvailable } from "./src/lib/scala-sync";
import { MonthGrid } from "./src/components/MonthGrid";
import { EventModal, EventDraft } from "./src/components/EventModal";
import { Drawer } from "./src/components/Drawer";
import { QRModal } from "./src/components/QRModal";
import { ScanModal } from "./src/components/ScanModal";
import * as Clipboard from "expo-clipboard";

const C = {
  bg: "#1e1e2e", surface: "#2a2a3c", text: "#cdd6f4", sub: "#9399b2",
  primary: "#89b4fa", border: "#313244", accent: "#a6e3a1", danger: "#f38ba8",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function atHour(d: Date, h: number) { const x = new Date(d); x.setHours(h, 0, 0, 0); return x; }
function msg(e: unknown) { return e instanceof Error ? e.message : String(e); }

export default function App() {
  const [cals, setCals] = useState<Calendar[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [status, setStatus] = useState("starting");
  const [shared, setShared] = useState(false);

  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(new Date());
  const [drawer, setDrawer] = useState(false);

  const [modal, setModal] = useState<{ open: boolean; draft: EventDraft; editing?: CalEvent; calId: string }>({
    open: false, draft: { title: "", startTime: Date.now(), endTime: Date.now() + 3600_000 }, calId: "",
  });

  const [newCalName, setNewCalName] = useState("");
  const [invite, setInvite] = useState("");
  const [lastInvite, setLastInvite] = useState("");
  const [qr, setQr] = useState<{ value: string; title: string } | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    setCals(await store.listCalendars());
    setEvents((await store.listEvents()).filter((e) => !e.deleted));
  }, []);

  useEffect(() => {
    refresh();
    const off = onChange(refresh);
    (async () => {
      setShared(await getSharedNode());
      if (!deliveryAvailable()) { setStatus("no delivery node in this build"); return; }
      try { await startSyncing(undefined, setStatus); } catch (e) { setStatus("sync error: " + msg(e)); }
    })();
    return off;
  }, [refresh]);

  const writable = useMemo(() => cals.filter((c) => c.encryptionKey), [cals]);
  const colorFor = useCallback((id: string) => cals.find((c) => c.id === id)?.color || C.primary, [cals]);
  const dayEvents = useMemo(
    () => events.filter((e) => sameDay(new Date(e.startTime), selected)).sort((a, b) => a.startTime - b.startTime),
    [events, selected],
  );

  const openNew = () => {
    if (writable.length === 0) { Alert.alert("No calendar", "Create or join a calendar first."); setDrawer(true); return; }
    setModal({
      open: true, calId: writable[0].id,
      draft: { title: "", startTime: atHour(selected, 9).getTime(), endTime: atHour(selected, 10).getTime() },
    });
  };
  const openEdit = (ev: CalEvent) =>
    setModal({ open: true, editing: ev, calId: ev.calendarId, draft: { id: ev.id, title: ev.title, startTime: ev.startTime, endTime: ev.endTime, description: ev.description } });

  const saveEvent = async (d: EventDraft) => {
    if (modal.editing) {
      await updateEvent({ ...modal.editing, title: d.title, startTime: d.startTime, endTime: d.endTime, description: d.description });
    } else {
      await createEvent(modal.calId, { title: d.title, startTime: d.startTime, endTime: d.endTime, description: d.description });
    }
    setModal((m) => ({ ...m, open: false }));
  };
  const removeEvent = async () => { if (modal.editing) await deleteEvent(modal.editing); setModal((m) => ({ ...m, open: false })); };

  const doCreateCal = async () => {
    const cal = await createCalendar(newCalName || "My calendar");
    setNewCalName(""); setLastInvite(buildInvite(cal));
    await startSyncing(undefined, setStatus);
    setQr({ value: buildInvite(cal), title: cal.name }); // show the QR right away
  };
  const showShare = (cal: Calendar) => { setLastInvite(buildInvite(cal)); setQr({ value: buildInvite(cal), title: cal.name }); };
  const copyInvite = async (link: string) => { await Clipboard.setStringAsync(link); Alert.alert("Copied", "Invite link copied to clipboard."); };
  const onScanned = async (data: string) => {
    setScanning(false);
    const cal = await joinFromInvite(data.trim());
    if (!cal) { Alert.alert("Not a Scala invite", "That QR isn't a scala://join link."); return; }
    await startSyncing(undefined, setStatus);
    Alert.alert("Joined", `Syncing "${cal.name}"`);
  };
  const doJoin = async () => {
    const cal = await joinFromInvite(invite.trim());
    if (!cal) { Alert.alert("Bad invite", "Expected a scala://join?cal=…&key=… link"); return; }
    setInvite(""); await startSyncing(undefined, setStatus);
    Alert.alert("Joined", `Syncing "${cal.name}"`);
  };
  const toggleShared = async (v: boolean) => { setShared(v); await setSharedNode(v); Alert.alert(v ? "Shared node ON" : "Shared node OFF", "Restart Scala to apply."); };
  const shiftMonth = (delta: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={["top", "left", "right", "bottom"]}>
        <StatusBar style="light" />

        {/* header */}
        <View style={s.header}>
          <Pressable onPress={() => setDrawer(true)} hitSlop={12}><Text style={s.menu}>☰</Text></Pressable>
          <Pressable onPress={() => shiftMonth(-1)} hitSlop={12}><Text style={s.nav}>‹</Text></Pressable>
          <Pressable onPress={() => { const n = new Date(); setCursor(n); setSelected(n); }} style={{ flex: 1 }}>
            <Text style={s.month}>{MONTHS[cursor.getMonth()]} {cursor.getFullYear()}</Text>
          </Pressable>
          <Pressable onPress={() => shiftMonth(1)} hitSlop={12}><Text style={s.nav}>›</Text></Pressable>
        </View>
        <Text style={s.status}>{status} · {cals.length} calendar(s)</Text>

        <View style={s.grid}>
          <MonthGrid
            month={cursor.getMonth()} year={cursor.getFullYear()}
            events={events} selected={selected} colorFor={colorFor} onSelect={setSelected}
          />
        </View>

        <View style={s.dayHead}>
          <Text style={s.dayTitle}>{selected.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text>
        </View>
        <ScrollView style={{ flex: 1 }}>
          {dayEvents.length === 0 && <Text style={[s.sub, { padding: 16 }]}>No events. Tap + to add one.</Text>}
          {dayEvents.map((ev) => (
            <Pressable key={ev.id} style={s.event} onPress={() => openEdit(ev)}>
              <View style={[s.dot, { backgroundColor: colorFor(ev.calendarId) }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.evTitle}>{ev.title}</Text>
                <Text style={s.sub}>
                  {new Date(ev.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  {" – "}{new Date(ev.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  {ev.description ? ` · ${ev.description}` : ""}
                </Text>
              </View>
            </Pressable>
          ))}
          <View style={{ height: 90 }} />
        </ScrollView>

        <Pressable style={s.fab} onPress={openNew}><Text style={s.fabT}>+</Text></Pressable>

        {/* left drawer: calendars */}
        <Drawer open={drawer} onClose={() => setDrawer(false)}>
          <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "bottom"]}>
            <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
              <View style={s.drawerHead}>
                <Text style={s.drawerTitle}>Calendars</Text>
                <Pressable onPress={() => setDrawer(false)} hitSlop={10}><Text style={s.back}>‹ Back</Text></Pressable>
              </View>

              <View style={s.rowBetween}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={s.pLabel}>Shared node</Text>
                  <Text style={s.sub}>Device-wide Logos Delivery. Restart to apply.</Text>
                </View>
                <Switch value={shared} onValueChange={toggleShared} trackColor={{ true: C.primary, false: C.border }} thumbColor="#fff" />
              </View>

              <Text style={s.pLabel}>Your calendars</Text>
              {cals.length === 0 && <Text style={s.sub}>None yet.</Text>}
              {cals.map((c) => (
                <View key={c.id} style={s.calRow}>
                  <View style={[s.dot, { backgroundColor: c.color }]} />
                  <Text style={s.calName}>{c.name}</Text>
                  {c.encryptionKey ? <Pressable onPress={() => showShare(c)}><Text style={s.share}>Share</Text></Pressable> : <Text style={s.sub}>local</Text>}
                </View>
              ))}

              <Text style={s.pLabel}>Create</Text>
              <View style={s.row}>
                <TextInput style={[s.input, { flex: 1 }]} value={newCalName} onChangeText={setNewCalName} placeholder="Name" placeholderTextColor={C.sub} />
                <Pressable style={s.smBtn} onPress={doCreateCal}><Text style={s.smBtnT}>Add</Text></Pressable>
              </View>

              <Text style={s.pLabel}>Join a calendar</Text>
              <View style={s.row}>
                <TextInput style={[s.input, { flex: 1 }]} value={invite} onChangeText={setInvite} placeholder="scala://join?…" placeholderTextColor={C.sub} autoCapitalize="none" />
                <Pressable style={s.smBtn} onPress={doJoin}><Text style={s.smBtnT}>Join</Text></Pressable>
              </View>
              <Pressable style={[s.smBtn, { marginTop: 8, alignItems: "center" }]} onPress={() => setScanning(true)}>
                <Text style={s.smBtnT}>Scan QR code</Text>
              </Pressable>

              {!!lastInvite && (
                <View style={{ marginTop: 12 }}>
                  <Text style={s.sub}>Last invite:</Text>
                  <TextInput style={[s.input, { marginTop: 6 }]} value={lastInvite} editable={false} multiline selectTextOnFocus />
                  <View style={[s.row, { marginTop: 8 }]}>
                    <Pressable style={[s.smBtn, { flex: 1, alignItems: "center" }]} onPress={() => copyInvite(lastInvite)}>
                      <Text style={s.smBtnT}>Copy</Text>
                    </Pressable>
                    <Pressable style={[s.smBtn, { flex: 1, alignItems: "center", backgroundColor: C.accent }]} onPress={() => setQr({ value: lastInvite, title: "Invite" })}>
                      <Text style={[s.smBtnT, { color: C.bg }]}>Show QR</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </ScrollView>
          </SafeAreaView>
        </Drawer>

        <QRModal visible={!!qr} value={qr?.value || ""} title={qr?.title || "Invite"} onClose={() => setQr(null)} />
        <ScanModal visible={scanning} onScanned={onScanned} onClose={() => setScanning(false)} />

        <EventModal
          visible={modal.open}
          initial={modal.draft}
          calendars={writable.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
          calendarId={modal.calId}
          onPickCalendar={(id) => setModal((m) => ({ ...m, calId: id }))}
          canPickCalendar={!modal.editing}
          onSave={saveEvent}
          onDelete={modal.editing ? removeEvent : undefined}
          onClose={() => setModal((m) => ({ ...m, open: false }))}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 6 },
  menu: { color: C.text, fontSize: 22, width: 24 },
  nav: { color: C.primary, fontSize: 26, fontWeight: "700", width: 20, textAlign: "center" },
  month: { color: C.text, fontSize: 20, fontWeight: "700" },
  status: { color: C.sub, fontSize: 11, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 6 },
  grid: { paddingHorizontal: 12, paddingTop: 4 },
  dayHead: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, borderTopWidth: 1, borderTopColor: C.border, marginTop: 6 },
  dayTitle: { color: C.text, fontSize: 15, fontWeight: "700" },
  event: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.surface, borderRadius: 10, padding: 12, marginHorizontal: 12, marginTop: 8, borderWidth: 1, borderColor: C.border },
  evTitle: { color: C.text, fontSize: 15, fontWeight: "600" },
  sub: { color: C.sub, fontSize: 12 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  fab: { position: "absolute", right: 20, bottom: 28, width: 60, height: 60, borderRadius: 30, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", elevation: 6 },
  fabT: { color: C.bg, fontSize: 32, fontWeight: "700", marginTop: -2 },
  drawerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  drawerTitle: { color: C.text, fontSize: 20, fontWeight: "700" },
  back: { color: C.primary, fontSize: 15, fontWeight: "600" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  pLabel: { color: C.text, fontSize: 13, fontWeight: "700", marginTop: 18, marginBottom: 6 },
  calRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  calName: { color: C.text, fontSize: 15, flex: 1 },
  share: { color: C.primary, fontSize: 13, fontWeight: "600" },
  input: { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 10 },
  smBtn: { backgroundColor: C.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11 },
  smBtnT: { color: C.bg, fontWeight: "700" },
});
