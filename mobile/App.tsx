// Scala mobile — shared calendar peer over Logos Delivery (SDS channels).
// Month grid + day detail + event editor; calendars live in a left drawer.
import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View, Text, TextInput, Pressable, Switch, ScrollView, StyleSheet, Alert, Modal, KeyboardAvoidingView, Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { store, Calendar, CalEvent, colorForId } from "./src/lib/store";
import {
  onChange, startSyncing, joinFromInvite, createEvent, updateEvent, deleteEvent,
  createCalendar, buildInvite, getSharedNode, setSharedNode,
  updateCalendarMeta, getAlias, setAlias, getEventHistory, myDeviceId, setMemberRole,
} from "./src/lib/calendar";
import { FieldDef } from "./src/components/EventModal";

const FIELD_TYPES = ["text", "longtext", "number", "date", "datetime", "bool", "url", "enum", "color"];
import { deliveryAvailable, getDebug, refreshDebug } from "./src/lib/scala-sync";
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
  const [newCalDesc, setNewCalDesc] = useState("");
  const [currentCalId, setCurrentCalId] = useState<string>("");     // #5: last-tapped calendar (preselected for new events)
  const [aliasMap, setAliasMap] = useState<Record<string, string>>({}); // #7: device-local name overrides
  const [calSet, setCalSet] = useState<{ cal: Calendar; name: string; desc: string; alias: string; schema: FieldDef[] } | null>(null); // #7 settings sheet
  const [nf, setNf] = useState<{ key: string; label: string; type: string }>({ key: "", label: "", type: "text" }); // #8 new custom field
  const [nm, setNm] = useState<{ id: string; role: "admin" | "viewer" }>({ id: "", role: "admin" }); // #3 new member
  const [invite, setInvite] = useState("");
  const [lastInvite, setLastInvite] = useState("");
  const [qr, setQr] = useState<{ value: string; title: string } | null>(null);
  const [dbg, setDbg] = useState<any>(null); // non-null → Debug panel open
  useEffect(() => {
    if (!dbg) return;
    let alive = true;
    const tick = async () => { await refreshDebug().catch(() => {}); if (alive) setDbg({ ...getDebug(), t: Date.now() }); };
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [!!dbg]);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    const cs = await store.listCalendars();
    setCals(cs);
    setEvents((await store.listEvents()).filter((e) => !e.deleted));
    const am: Record<string, string> = {};
    for (const c of cs) { const a = await getAlias(c.id); if (a) am[c.id] = a; }
    setAliasMap(am);
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
  const me = useMemo(() => myDeviceId(), [cals]);
  const displayName = useCallback((c: Calendar) => aliasMap[c.id] || c.name, [aliasMap]);
  const roleOf = useCallback((c: Calendar): string => {
    if (!c.rolesConfigured) return "open";
    if (c.owner && c.owner === me) return "owner";
    return c.roles?.[me] || "viewer";
  }, [me]);
  const openCalSettings = (c: Calendar) => {
    setNf({ key: "", label: "", type: "text" }); setNm({ id: "", role: "admin" });
    setCalSet({ cal: c, name: c.name, desc: c.description || "", alias: aliasMap[c.id] || "", schema: c.schema ? [...c.schema] : [] });
  };
  const saveCalSettings = async () => {
    if (!calSet) return;
    if (calSet.name.trim() && calSet.name !== calSet.cal.name) await updateCalendarMeta(calSet.cal.id, { name: calSet.name });
    if ((calSet.desc || "") !== (calSet.cal.description || "")) await updateCalendarMeta(calSet.cal.id, { description: calSet.desc });
    if (JSON.stringify(calSet.schema) !== JSON.stringify(calSet.cal.schema || [])) await updateCalendarMeta(calSet.cal.id, { schema: calSet.schema });
    await setAlias(calSet.cal.id, calSet.alias);
    setCalSet(null);
  };
  // #8: custom-field schema editing (staged in calSet, written on Save).
  const addField = () => {
    const key = nf.key.trim().replace(/\s+/g, "_");
    if (!key || !calSet) return;
    if (calSet.schema.some((f) => f.key === key)) { Alert.alert("Field exists", `"${key}" is already defined.`); return; }
    setCalSet((v) => v && { ...v, schema: [...v.schema, { key, label: nf.label.trim() || key, type: nf.type }] });
    setNf({ key: "", label: "", type: "text" });
  };
  const removeField = (key: string) => setCalSet((v) => v && { ...v, schema: v.schema.filter((f) => f.key !== key) });
  // #3: role management — writes a member.set event immediately (owner/admin only; the fold enforces it).
  const canManage = !!calSet && (calSet.cal.owner === me || calSet.cal.roles?.[me] === "admin");
  const members: [string, string][] = calSet
    ? [...(calSet.cal.owner ? [[calSet.cal.owner, "owner"] as [string, string]] : []),
       ...Object.entries(calSet.cal.roles || {}).filter(([id]) => id !== calSet.cal.owner)]
    : [];
  const addMember = async () => {
    const id = nm.id.trim();
    if (!id || !calSet) return;
    await setMemberRole(calSet.cal.id, id, nm.role);
    setNm({ id: "", role: "admin" });
    Alert.alert("Member added", `${id.slice(0, 16)}… is now ${nm.role}. They'll appear once the change syncs.`);
    setCalSet(null);
  };
  const removeMember = async (id: string) => {
    if (!calSet) return;
    await setMemberRole(calSet.cal.id, id, "remove");
    setCalSet(null);
  };
  const copyIdentity = async () => { await Clipboard.setStringAsync(me); Alert.alert("Copied", "Your identity is on the clipboard — share it so an owner can add you."); };
  const colorFor = useCallback((id: string) => colorForId(id), []);
  const dayEvents = useMemo(
    () => events.filter((e) => sameDay(new Date(e.startTime), selected)).sort((a, b) => a.startTime - b.startTime),
    [events, selected],
  );

  const openNew = () => {
    if (writable.length === 0) { Alert.alert("No calendar", "Create or join a calendar first."); setDrawer(true); return; }
    // #5: default to the calendar you last tapped, not always the first one.
    const calId = writable.find((c) => c.id === currentCalId)?.id || writable[0].id;
    setModal({
      open: true, calId,
      draft: { title: "", startTime: atHour(selected, 9).getTime(), endTime: atHour(selected, 10).getTime() },
    });
  };
  const openEdit = (ev: CalEvent) =>
    setModal({ open: true, editing: ev, calId: ev.calendarId, draft: { id: ev.id, title: ev.title, startTime: ev.startTime, endTime: ev.endTime, description: ev.description, fields: ev.fields } });

  const saveEvent = async (d: EventDraft) => {
    if (modal.editing) {
      await updateEvent({ ...modal.editing, title: d.title, startTime: d.startTime, endTime: d.endTime, description: d.description, fields: d.fields });
    } else {
      await createEvent(modal.calId, { title: d.title, startTime: d.startTime, endTime: d.endTime, description: d.description, fields: d.fields });
    }
    setModal((m) => ({ ...m, open: false }));
  };
  const removeEvent = async () => { if (modal.editing) await deleteEvent(modal.editing); setModal((m) => ({ ...m, open: false })); };

  const doCreateCal = async () => {
    const cal = await createCalendar(newCalName || "My calendar", "#89b4fa", newCalDesc);
    setNewCalName(""); setNewCalDesc(""); setCurrentCalId(cal.id); setLastInvite(buildInvite(cal));
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
        <Pressable onPress={() => setDbg({ ...getDebug(), t: Date.now() })}>
          <Text style={s.status}>{status} · {cals.length} calendar(s) · <Text style={{ textDecorationLine: "underline" }}>debug</Text></Text>
        </Pressable>

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
                <Pressable key={c.id} onPress={() => { setCurrentCalId(c.id); setDrawer(false); }} style={s.calRow}>
                  <View style={[s.dot, { backgroundColor: colorForId(c.id) }]} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={s.calName}>{displayName(c)}</Text>
                      {currentCalId === c.id && <Text style={[s.roleBadge, { color: C.accent, borderColor: C.accent }]}>active</Text>}
                      {!!aliasMap[c.id] && <Text style={s.roleBadge}>alias</Text>}
                      {c.rolesConfigured && <Text style={s.roleBadge}>{roleOf(c)}</Text>}
                    </View>
                    {!!c.description && <Text style={s.sub} numberOfLines={2}>{c.description}</Text>}
                  </View>
                  <Pressable onPress={() => openCalSettings(c)} hitSlop={8}><Text style={s.share}>Edit</Text></Pressable>
                  {c.encryptionKey ? <Pressable onPress={() => showShare(c)} hitSlop={8}><Text style={s.share}>Share</Text></Pressable> : <Text style={s.sub}>local</Text>}
                </Pressable>
              ))}

              <Text style={s.pLabel}>Create</Text>
              <View style={s.row}>
                <TextInput style={[s.input, { flex: 1 }]} value={newCalName} onChangeText={setNewCalName} placeholder="Name" placeholderTextColor={C.sub} />
                <Pressable style={s.smBtn} onPress={doCreateCal}><Text style={s.smBtnT}>Add</Text></Pressable>
              </View>
              <TextInput style={[s.input, { marginTop: 8 }]} value={newCalDesc} onChangeText={setNewCalDesc} placeholder="Description (optional)" placeholderTextColor={C.sub} />

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

        {/* #7: per-calendar settings — shared name/description (cal.meta) + a LOCAL alias. */}
        <Modal visible={!!calSet} animationType="slide" transparent onRequestClose={() => setCalSet(null)}>
          <KeyboardAvoidingView style={s.sheetBackdrop} behavior={Platform.OS === "ios" ? "padding" : "height"}>
            <View style={s.sheet}>
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={s.drawerTitle}>Calendar settings</Text>
                <Text style={s.pLabel}>Name (shared)</Text>
                <TextInput style={s.input} value={calSet?.name || ""} onChangeText={(t) => setCalSet((v) => v && { ...v, name: t })} placeholderTextColor={C.sub} />
                <Text style={s.pLabel}>Description (shared)</Text>
                <TextInput style={[s.input, { height: 64 }]} value={calSet?.desc || ""} onChangeText={(t) => setCalSet((v) => v && { ...v, desc: t })} placeholder="What this calendar is for" placeholderTextColor={C.sub} multiline />
                <Text style={s.pLabel}>Local alias (only on this phone)</Text>
                <TextInput style={s.input} value={calSet?.alias || ""} onChangeText={(t) => setCalSet((v) => v && { ...v, alias: t })} placeholder={calSet?.cal.name} placeholderTextColor={C.sub} />

                {/* #8: custom fields — define the calendar's schema (empty = a plain calendar). */}
                <Text style={s.pLabel}>Custom fields</Text>
                {calSet?.schema.length === 0 && <Text style={[s.sub, { marginBottom: 6 }]}>None — a plain calendar. Add fields to capture more per event.</Text>}
                {calSet?.schema.map((f) => (
                  <View key={f.key} style={s.fieldRow}>
                    <Text style={{ color: C.text, flex: 1 }}>{f.label || f.key} <Text style={{ color: C.sub, fontSize: 12 }}>· {f.type}</Text></Text>
                    <Pressable onPress={() => removeField(f.key)} hitSlop={8}><Text style={{ color: C.danger, fontSize: 18 }}>×</Text></Pressable>
                  </View>
                ))}
                <View style={s.row2}>
                  <TextInput style={[s.input, { flex: 1 }]} value={nf.key} onChangeText={(t) => setNf((v) => ({ ...v, key: t }))} placeholder="key" placeholderTextColor={C.sub} autoCapitalize="none" />
                  <TextInput style={[s.input, { flex: 1 }]} value={nf.label} onChangeText={(t) => setNf((v) => ({ ...v, label: t }))} placeholder="Label" placeholderTextColor={C.sub} />
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {FIELD_TYPES.map((t) => (
                      <Pressable key={t} onPress={() => setNf((v) => ({ ...v, type: t }))} style={[s.typeChip, nf.type === t && s.typeChipOn]}>
                        <Text style={[s.typeChipT, nf.type === t && { color: C.bg }]}>{t}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
                <Pressable style={[s.smBtn, { marginTop: 8, alignItems: "center", backgroundColor: C.surface, borderWidth: 1, borderColor: C.border }]} onPress={addField}><Text style={[s.smBtnT, { color: C.text }]}>+ Add field</Text></Pressable>

                {/* #3: sharing & roles — who can edit. Identity = a device id; share yours to be added. */}
                <Text style={s.pLabel}>Sharing &amp; roles</Text>
                <Text style={[s.sub, { marginBottom: 6 }]}>
                  {calSet?.cal.rolesConfigured
                    ? `Role-managed. Your role: ${calSet ? roleOf(calSet.cal) : ""}${roleOf(calSet!.cal) === "viewer" ? " — your shared edits won't apply." : "."}`
                    : "Open — anyone with the invite link can edit. Add a member below to make it role-managed (owner sets admins; others become viewers)."}
                </Text>
                <View style={[s.fieldRow, { backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, paddingHorizontal: 10 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: C.sub, fontSize: 11 }}>Your identity (share this to be added)</Text>
                    <Text style={{ color: C.text, fontFamily: "monospace", fontSize: 12 }} numberOfLines={1}>{me}</Text>
                  </View>
                  <Pressable onPress={copyIdentity} hitSlop={8}><Text style={{ color: C.primary, fontWeight: "700" }}>Copy</Text></Pressable>
                </View>
                {members.map(([id, role]) => (
                  <View key={id} style={s.fieldRow}>
                    <Text style={{ color: C.text, flex: 1, fontFamily: "monospace", fontSize: 12 }} numberOfLines={1}>
                      {id === me ? "you" : id.replace(/^scala-/, "").slice(0, 12)} <Text style={{ color: C.sub }}>· {role}</Text>
                    </Text>
                    {canManage && role !== "owner" && <Pressable onPress={() => removeMember(id)} hitSlop={8}><Text style={{ color: C.danger, fontSize: 18 }}>×</Text></Pressable>}
                  </View>
                ))}
                {canManage && (
                  <>
                    <TextInput style={[s.input, { marginTop: 6 }]} value={nm.id} onChangeText={(t) => setNm((v) => ({ ...v, id: t }))} placeholder="Paste a member's identity" placeholderTextColor={C.sub} autoCapitalize="none" />
                    <View style={[s.row2, { marginTop: 6, alignItems: "center" }]}>
                      {(["admin", "viewer"] as const).map((r) => (
                        <Pressable key={r} onPress={() => setNm((v) => ({ ...v, role: r }))} style={[s.typeChip, nm.role === r && s.typeChipOn]}>
                          <Text style={[s.typeChipT, nm.role === r && { color: C.bg }]}>{r}</Text>
                        </Pressable>
                      ))}
                      <Pressable style={[s.smBtn, { flex: 1, alignItems: "center", backgroundColor: C.accent }]} onPress={addMember}><Text style={[s.smBtnT, { color: C.bg }]}>Add member</Text></Pressable>
                    </View>
                  </>
                )}

                <Pressable style={[s.smBtn, { marginTop: 18, alignItems: "center", backgroundColor: C.accent }]} onPress={saveCalSettings}><Text style={[s.smBtnT, { color: C.bg }]}>Save</Text></Pressable>
                <Pressable style={[s.smBtn, { marginTop: 8, alignItems: "center", backgroundColor: "transparent" }]} onPress={() => setCalSet(null)}><Text style={[s.smBtnT, { color: C.sub }]}>Cancel</Text></Pressable>
                <View style={{ height: 20 }} />
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <QRModal visible={!!qr} value={qr?.value || ""} title={qr?.title || "Invite"} onClose={() => setQr(null)} />
        <ScanModal visible={scanning} onScanned={onScanned} onClose={() => setScanning(false)} />

        {/* Debug panel — live connection, publish confirmation, receive stages, event log */}
        <Modal visible={!!dbg} animationType="slide" onRequestClose={() => setDbg(null)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: "#0f1115" }}>
            <View style={{ flexDirection: "row", alignItems: "center", padding: 14 }}>
              <Text style={{ color: "#e8eaed", fontSize: 18, fontWeight: "700", flex: 1 }}>Sync debug</Text>
              <Pressable onPress={() => setDbg(null)} hitSlop={12}><Text style={{ color: "#6ea8fe", fontSize: 16 }}>Close</Text></Pressable>
            </View>
            <ScrollView style={{ flex: 1, paddingHorizontal: 14 }}>
              {dbg && (() => {
                const row = (k: string, v: any, warn = false) => (
                  <View style={{ flexDirection: "row", paddingVertical: 3 }} key={k}>
                    <Text style={{ color: "#9aa1ad", width: 130, fontFamily: "monospace", fontSize: 12 }}>{k}</Text>
                    <Text style={{ color: warn ? "#f38ba8" : "#e8eaed", flex: 1, fontFamily: "monospace", fontSize: 12 }}>{String(v)}</Text>
                  </View>
                );
                return (
                  <>
                    <Text style={{ color: "#89b4fa", marginTop: 8, marginBottom: 4, fontWeight: "700" }}>Node</Text>
                    {row("backend", `${dbg.backend} (${shared ? "shared service" : "embedded"})`)}
                    {row("mode", dbg.mode)}
                    {row("routes", dbg.routes)}
                    {row("peers / mesh", `${dbg.peers} / ${dbg.mesh}`)}
                    {row("store", dbg.store || "—")}

                    <Text style={{ color: "#89b4fa", marginTop: 12, marginBottom: 4, fontWeight: "700" }}>Publish (tx)</Text>
                    {row("attempted", dbg.tx.attempt)}
                    {row("sent OK", dbg.tx.sent)}
                    {row("failed", dbg.tx.fail, dbg.tx.fail > 0)}
                    {row("last error", dbg.tx.lastErr || "—", !!dbg.tx.lastErr)}

                    <Text style={{ color: "#89b4fa", marginTop: 12, marginBottom: 4, fontWeight: "700" }}>Receive (rx)</Text>
                    {row("raw", dbg.rx.raw)}
                    {row("opened", dbg.rx.opened)}
                    {row("open-fail", dbg.rx.openFail, dbg.rx.openFail > 0)}
                    {row("new / dup", `${dbg.rx.new} / ${dbg.rx.dup}`)}
                    {row("sample", dbg.sample || "—")}

                    <Text style={{ color: "#89b4fa", marginTop: 12, marginBottom: 4, fontWeight: "700" }}>Event log ({events.length})</Text>
                    {[...events].sort((a, b) => b.startTime - a.startTime).slice(0, 40).map((e) => (
                      <View key={e.id} style={{ paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#2a2e37" }}>
                        <Text style={{ color: "#e8eaed", fontSize: 12 }}>{e.title}</Text>
                        <Text style={{ color: "#9aa1ad", fontSize: 11, fontFamily: "monospace" }}>
                          {new Date(e.startTime).toLocaleString()} · by {(e.creatorId || "?").slice(0, 16)}
                        </Text>
                      </View>
                    ))}
                    <View style={{ height: 40 }} />
                  </>
                );
              })()}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        <EventModal
          visible={modal.open}
          initial={modal.draft}
          calendars={writable.map((c) => ({ id: c.id, name: c.name, color: colorForId(c.id) }))}
          calendarId={modal.calId}
          onPickCalendar={(id) => setModal((m) => ({ ...m, calId: id }))}
          canPickCalendar={!modal.editing}
          onSave={saveEvent}
          onDelete={modal.editing ? removeEvent : undefined}
          onClose={() => setModal((m) => ({ ...m, open: false }))}
          schema={cals.find((c) => c.id === modal.calId)?.schema || []}
          loadHistory={modal.editing ? () => getEventHistory(modal.calId, modal.editing!.id) : undefined}
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
  roleBadge: { fontSize: 10, fontWeight: "700", color: "#9399b2", borderColor: "#313244", borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden", textTransform: "uppercase" },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#2a2a3c", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "88%" },
  fab: { position: "absolute", right: 20, bottom: 28, width: 60, height: 60, borderRadius: 30, backgroundColor: C.primary, alignItems: "center", justifyContent: "center", elevation: 6 },
  fabT: { color: C.bg, fontSize: 32, fontWeight: "700", marginTop: -2 },
  drawerHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  drawerTitle: { color: C.text, fontSize: 20, fontWeight: "700" },
  back: { color: C.primary, fontSize: 15, fontWeight: "600" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  pLabel: { color: C.text, fontSize: 13, fontWeight: "700", marginTop: 18, marginBottom: 6 },
  fieldRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  row2: { flexDirection: "row", gap: 8 },
  typeChip: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  typeChipOn: { backgroundColor: C.primary, borderColor: C.primary },
  typeChipT: { color: C.sub, fontSize: 12, fontWeight: "600" },
  calRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  calName: { color: C.text, fontSize: 15, flex: 1 },
  share: { color: C.primary, fontSize: 13, fontWeight: "600" },
  input: { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 10 },
  smBtn: { backgroundColor: C.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11 },
  smBtnT: { color: C.bg, fontWeight: "700" },
});
