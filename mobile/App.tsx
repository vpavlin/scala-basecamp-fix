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
  createCalendar, deleteCalendar, buildInvite, getSharedNode, setSharedNode,
  updateCalendarMeta, getAlias, setAlias, getEventHistory, getDeviceId, setMemberRole,
  setCalendarIdentity, calendarIdentityId,
} from "./src/lib/calendar";
import { FieldDef } from "./src/components/EventModal";

const FIELD_TYPES = ["text", "longtext", "number", "date", "datetime", "bool", "url", "enum", "color"];
import { deliveryAvailable, getDebug, refreshDebug } from "./src/lib/scala-sync";
import { SharedNodeStatus } from "./src/lib/loam-transport-pkg/src/SharedNodeStatus";
import { ensureNotifyPermission, scheduleReminders } from "./src/lib/notify";
import { MonthGrid } from "./src/components/MonthGrid";
import { expandEvents } from "./src/lib/recur";
import { EventModal, EventDraft } from "./src/components/EventModal";
import { Drawer } from "./src/components/Drawer";
import { IdentitiesPanel, KeycardTapOverlay, KeycardPinGate } from "./src/components/KeycardProbe";
import { listIdentities, getDefaultIdentityId, identityForCalendar } from "./src/lib/identities";
import * as sstat from "./src/lib/syncstatus";

// Per-calendar sync freshness chip (offline / syncing N / up-to-date), fed by syncstatus.ts.
function SyncChip({ calId }: { calId: string }) {
  const [, bump] = useState(0);
  useEffect(() => sstat.onSyncChange(() => bump((n) => n + 1)), []);
  const st = sstat.getCalSync(calId);
  const [bg, fg, label] = !st.online
    ? ["#3a2f1a", "#f9e2af", "offline"]
    : st.syncing
      ? ["#1e2f4a", "#89b4fa", st.behind > 0 ? `syncing ${st.behind}` : "syncing…"]
      : ["#1e3a2a", "#a6e3a1", "up to date"];
  return <Text style={{ fontSize: 10, fontWeight: "700", color: fg, backgroundColor: bg, borderColor: fg, borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, overflow: "hidden", textTransform: "uppercase" }}>{label}</Text>;
}
import { QRModal } from "./src/components/QRModal";
import { ScanModal } from "./src/components/ScanModal";
import * as Clipboard from "expo-clipboard";
import { updateWidgetAgenda } from "./src/lib/widget";

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
  const [viewMode, setViewMode] = useState<"month" | "agenda">("month"); // month grid vs. upcoming agenda
  const [query, setQuery] = useState(""); // agenda search
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
  const [newCalIdentity, setNewCalIdentity] = useState("");   // which identity authors the new calendar
  const [identities, setIdentities] = useState<{ id: string; kind: string; label: string; address: string }[]>([]);
  const [newCalOpen, setNewCalOpen] = useState(false);        // full "new calendar" form modal
  const [newCalSchema, setNewCalSchema] = useState<FieldDef[]>([]); // custom fields, set at create
  const [newCalCanAdd, setNewCalCanAdd] = useState(false);    // "Open — anyone can add" (default CLOSED — opening is deliberate)
  const [joinIdentity, setJoinIdentity] = useState("");       // identity to author my events on a joined calendar
  const [calSetIdentity, setCalSetIdentity] = useState("");   // the open calendar-settings sheet's bound identity
  const [currentCalId, setCurrentCalId] = useState<string>("");     // #5: last-tapped calendar (preselected for new events)
  const [aliasMap, setAliasMap] = useState<Record<string, string>>({}); // #7: device-local name overrides
  const [calSet, setCalSet] = useState<{ cal: Calendar; name: string; desc: string; alias: string; schema: FieldDef[] } | null>(null); // #7 settings sheet
  const [nf, setNf] = useState<{ key: string; label: string; type: string }>({ key: "", label: "", type: "text" }); // #8 new custom field
  const [nm, setNm] = useState<{ id: string; role: "editor" | "viewer" }>({ id: "", role: "editor" }); // #3 new member
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
    const evs = (await store.listEvents()).filter((e) => !e.deleted);
    setEvents(evs);
    scheduleReminders(evs); // #1: keep local event reminders in step with the data
    const am: Record<string, string> = {};
    for (const c of cs) { const a = await getAlias(c.id); if (a) am[c.id] = a; }
    setAliasMap(am);
  }, []);

  useEffect(() => {
    refresh();
    ensureNotifyPermission(); // #1: ask once so reminders can be scheduled
    const off = onChange(refresh);
    (async () => {
      setShared(await getSharedNode());
      if (!deliveryAvailable()) { setStatus("no delivery node in this build"); return; }
      try { await startSyncing(undefined, setStatus); } catch (e) { setStatus("sync error: " + msg(e)); }
    })();
    return off;
  }, [refresh]);

  const writable = useMemo(() => cals.filter((c) => c.encryptionKey), [cals]);
  // Real stable per-install id (SecureStore), loaded async — NOT the "scala-default"
  // placeholder that myDeviceId() returns before the clock initializes.
  const [me, setMe] = useState("");
  useEffect(() => { getDeviceId().then(setMe).catch(() => {}); }, []);
  useEffect(() => { sstat.setOnline(/connected/i.test(status)); }, [status]); // feed the per-calendar chip
  useEffect(() => {
    let alive = true;
    const load = async () => { try { const l = await listIdentities(); if (alive) setIdentities(l); } catch { /* */ } };
    load(); const t = setInterval(load, 3000);
    getDefaultIdentityId().then((d) => { if (alive) { setNewCalIdentity((cur) => cur || d); setJoinIdentity((cur) => cur || d); } }).catch(() => {});
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => {   // load the open settings-sheet's calendar→identity binding
    if (!calSet) return;
    let alive = true;
    (async () => { try { const b = await calendarIdentityId(calSet.cal.id); const d = await getDefaultIdentityId(); if (alive) setCalSetIdentity(b || d); } catch { /* */ } })();
    return () => { alive = false; };
  }, [calSet?.cal.id]);
  const displayName = useCallback((c: Calendar) => aliasMap[c.id] || c.name, [aliasMap]);
  const roleOf = useCallback((c: Calendar): string => {
    if (!c.rolesConfigured) return "open";
    if (c.owner && c.owner === me) return "owner";
    return c.roles?.[me] || "viewer";
  }, [me]);
  // Two-rule permissions (mirror the fold): owner/editors do anything; viewers read-only;
  // everyone else may ADD iff Open, and edit/delete only events they authored.
  // Permission checks must use the address that will ACTUALLY author events on this calendar — its
  // BOUND identity (per-calendar), not the single global default. A Keycard-owned calendar bound to
  // the Keycard identity is writable even when the global default is the device key. meFor maps
  // calId → that authoring address; falls back to `me` until resolved.
  const [meFor, setMeFor] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(cals.map(async (c) => [c.id, (await identityForCalendar(c.id)).address] as const));
      if (alive) setMeFor(Object.fromEntries(entries));
    })();
    return () => { alive = false; };
  }, [cals, identities]);
  const addrFor = useCallback((c?: Calendar) => (c && meFor[c.id]) || me, [meFor, me]);
  const isEditorMe = useCallback((c?: Calendar) => { if (!c) return true; const a = addrFor(c); return c.owner === a || c.roles?.[a] === "editor" || c.roles?.[a] === "admin"; }, [addrFor]);
  const isViewerMe = useCallback((c?: Calendar) => { if (!c) return false; return c.roles?.[addrFor(c)] === "viewer"; }, [addrFor]);
  const canAddTo = useCallback((c?: Calendar) => isEditorMe(c) || (!isViewerMe(c) && c?.open !== false), [isEditorMe, isViewerMe]);
  const canEditEvent = useCallback((c?: Calendar, ev?: CalEvent) => isEditorMe(c) || (!isViewerMe(c) && !!ev && ev.creatorId === addrFor(c)), [isEditorMe, isViewerMe, addrFor]);
  // Human "why can't I edit this" — the identity that WOULD author here (addrFor) vs owner/roles.
  const shortA = (a?: string) => (a ? a.replace(/^scala-/, "").slice(0, 10) + "…" : "?");
  const readonlyReason = useCallback((c?: Calendar, ev?: CalEvent): string => {
    if (!c) return "";
    const a = addrFor(c);
    if (isViewerMe(c)) return `You're a viewer on "${c.name}" — read-only.`;
    if (ev && ev.creatorId && !isEditorMe(c) && ev.creatorId !== a)
      return `Only the author can edit this event (created by ${shortA(ev.creatorId)}). You're signing as ${shortA(a)}.`;
    if (c.owner && a !== c.owner && !isEditorMe(c))
      return `This calendar is owned by ${shortA(c.owner)}, but you're signing as ${shortA(a)}. If that owner was a Keycard you re-enrolled, its address changed and this calendar is orphaned — make a new one, or bind an identity that owns/edits it.`;
    if (c.open === false && !isEditorMe(c))
      return `"${c.name}" is closed — only its owner/editors can add events. You're signing as ${shortA(a)}.`;
    return `You can't write to "${c.name}" as ${shortA(a)}.`;
  }, [addrFor, isEditorMe, isViewerMe]);
  // Calendars you can actually add events to (skip read-only / orphaned-owner) — for the + button
  // and the new-event calendar picker. Falls back to all writable if none qualify.
  const addableCals = useMemo(() => writable.filter((c) => canAddTo(c)), [writable, canAddTo]);
  const pickCals = addableCals.length ? addableCals : writable;
  const openCalSettings = (c: Calendar) => {
    setNf({ key: "", label: "", type: "text" }); setNm({ id: "", role: "editor" });
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
  const canManage = !!calSet && (calSet.cal.owner === me || calSet.cal.roles?.[me] === "editor" || calSet.cal.roles?.[me] === "admin");
  const members: [string, string][] = calSet
    ? [...(calSet.cal.owner ? [[calSet.cal.owner, "owner"] as [string, string]] : []),
       ...Object.entries(calSet.cal.roles || {}).filter(([id]) => id !== calSet.cal.owner)]
    : [];
  const addMember = async () => {
    const id = nm.id.trim();
    if (!id || !calSet) return;
    await setMemberRole(calSet.cal.id, id, nm.role);
    setNm({ id: "", role: "editor" });
    Alert.alert("Member added", `${id.slice(0, 16)}… is now ${nm.role}. They'll appear once the change syncs.`);
    setCalSet(null);
  };
  const removeMember = async (id: string) => {
    if (!calSet) return;
    await setMemberRole(calSet.cal.id, id, "remove");
    setCalSet(null);
  };
  const copyIdentity = async () => { await Clipboard.setStringAsync(me); Alert.alert("Copied", "Your identity is on the clipboard — share it so an owner can add you."); };
  const removeCalendar = () => {
    if (!calSet) return;
    const c = calSet.cal;
    Alert.alert(
      "Delete calendar",
      `Remove "${displayName(c)}" from this device? A shared calendar can't be deleted for others — this just stops it syncing here. You can rejoin with the invite link.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: async () => {
          if (currentCalId === c.id) setCurrentCalId("");
          setCalSet(null);
          await deleteCalendar(c.id);
        } },
      ],
    );
  };
  const colorFor = useCallback((id: string) => colorForId(id), []);
  // Expand recurrence occurrences for the selected day (non-recurring events pass through once).
  const dayEvents = useMemo(() => {
    const ds = new Date(selected); ds.setHours(0, 0, 0, 0);
    const de = new Date(selected); de.setHours(23, 59, 59, 999);
    return expandEvents(events, ds.getTime(), de.getTime()).filter((o) => sameDay(new Date(o.startTime), selected));
  }, [events, selected]);
  // Occurrences across the visible month (± a week for grid spillover) → month-grid dots.
  const monthEvents = useMemo(() => {
    const ws = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getTime() - 7 * 864e5;
    const we = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999).getTime() + 7 * 864e5;
    return expandEvents(events, ws, we);
  }, [events, cursor]);
  // Agenda: occurrences grouped by day. Default = next 90 days from today; a search widens the
  // window (−30d … +365d) and filters by title/location/description across all calendars.
  const agenda = useMemo(() => {
    const now = new Date(); const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const q = query.trim().toLowerCase();
    const start = q ? now.getTime() - 30 * 864e5 : t0.getTime();
    const end = q ? now.getTime() + 365 * 864e5 : t0.getTime() + 90 * 864e5;
    let occ = expandEvents(events, start, end);
    if (q) occ = occ.filter((o) => `${o.title || ""} ${o.location || ""} ${o.description || ""}`.toLowerCase().includes(q));
    occ.sort((a, b) => a.startTime - b.startTime);
    const groups: { key: string; date: Date; items: CalEvent[] }[] = [];
    for (const o of occ) {
      const d = new Date(o.startTime); const key = d.toDateString();
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, date: d, items: [] }; groups.push(g); }
      g.items.push(o);
    }
    return groups;
  }, [events, query]);

  // Feed the home-screen agenda widget: the next ~12 upcoming occurrences (independent of the
  // in-app search), refreshed whenever events/calendars change. Local-only, so it updates offline.
  const widgetItems = useMemo(() => {
    const now = Date.now();
    return expandEvents(events, now, now + 90 * 864e5)
      .filter((o) => o.endTime >= now)
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 12)
      .map((o) => {
        const cal = cals.find((c) => c.id === o.calendarId);
        const d = new Date(o.startTime);
        return {
          title: o.title || "(untitled)",
          timeLabel: o.allDay ? "All day" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
          dateLabel: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
          calendar: cal ? displayName(cal) : "",
          color: colorFor(o.calendarId),
        };
      });
  }, [events, cals, displayName, colorFor]);
  useEffect(() => { updateWidgetAgenda(widgetItems); }, [widgetItems]);

  const openNew = () => {
    if (writable.length === 0) { Alert.alert("No calendar", "Create or join a calendar first."); setDrawer(true); return; }
    // #5: default to the calendar you last tapped; prefer one you can actually add to (skip
    // read-only / orphaned-owner calendars) so the editor doesn't open pre-locked.
    const calId = pickCals.find((c) => c.id === currentCalId)?.id || pickCals[0].id;
    setModal({
      open: true, calId,
      draft: { title: "", startTime: atHour(selected, 9).getTime(), endTime: atHour(selected, 10).getTime() },
    });
  };
  // Series-based v1: editing an occurrence edits the MASTER (found by id in `events`),
  // so the editor shows the real start date + recurrence rule and changes apply to the series.
  const openEdit = (occ: CalEvent) => {
    const m = events.find((e) => e.id === occ.id) || occ;
    setModal({
      open: true, editing: m, calId: m.calendarId,
      draft: {
        id: m.id, title: m.title, startTime: m.startTime, endTime: m.endTime, description: m.description,
        location: m.location, url: m.url, allDay: m.allDay, reminderMin: m.reminderMin, recur: m.recur, fields: m.fields,
      },
    });
  };

  // A Keycard sign was cancelled or failed → the create was aborted (nothing saved). Cancel is
  // silent (editor stays open). A real tap failure gets a friendly message + a Retry that re-runs
  // the same action (so a flaky NFC tap doesn't lose the edit).
  const onKeycardAbort = (e: any, retry?: () => void) => {
    const raw = String((e && e.message) || e || "");
    if (raw.includes("cancelled")) return; // user cancelled — keep the editor open
    const friendly = /pin/i.test(raw) ? "Wrong PIN, or the card moved mid-tap."
      : /pairing/i.test(raw) ? "Pairing failed — check the pairing password."
      : /node-null|no link|CardIO|Error sending|transceive|timeout|Tag was lost/i.test(raw) ? "The card connection dropped — hold it steady over the NFC spot and try again."
      : raw;
    Alert.alert("Couldn't save", friendly + "\n\nNothing was saved.",
      retry ? [{ text: "Discard", style: "cancel" }, { text: "Retry", onPress: retry }] : [{ text: "OK" }]);
  };
  const saveEvent = async (d: EventDraft) => {
    const common = {
      title: d.title, startTime: d.startTime, endTime: d.endTime, description: d.description,
      location: d.location, url: d.url, allDay: d.allDay, reminderMin: d.reminderMin, recur: d.recur, fields: d.fields,
    };
    try {
      if (modal.editing) await updateEvent({ ...modal.editing, ...common });
      else await createEvent(modal.calId, common);
      setModal((m) => ({ ...m, open: false }));
    } catch (e: any) { onKeycardAbort(e, () => saveEvent(d)); }
  };
  const removeEvent = async () => {
    if (!modal.editing) return;
    try { await deleteEvent(modal.editing); setModal((m) => ({ ...m, open: false })); } catch (e: any) { onKeycardAbort(e, () => removeEvent()); }
  };

  // Custom-field editing for the NEW-calendar form (mirrors settings' addField/removeField, staged
  // in newCalSchema and written into the single cal.meta on Create). Reuses the `nf` input.
  const addNewCalField = () => {
    const key = nf.key.trim().replace(/\s+/g, "_");
    if (!key) return;
    if (newCalSchema.some((f) => f.key === key)) { Alert.alert("Field exists", `"${key}" is already defined.`); return; }
    setNewCalSchema((v) => [...v, { key, label: nf.label.trim() || key, type: nf.type }]);
    setNf({ key: "", label: "", type: "text" });
  };
  const removeNewCalField = (key: string) => setNewCalSchema((v) => v.filter((f) => f.key !== key));
  const doCreateCal = async () => {
    try {
      const cal = await createCalendar(newCalName || "My calendar", "#89b4fa", newCalDesc, newCalIdentity || undefined,
        { schema: newCalSchema, open: newCalCanAdd });
      setNewCalOpen(false);
      setNewCalName(""); setNewCalDesc(""); setNewCalSchema([]); setNewCalCanAdd(false);
      setNf({ key: "", label: "", type: "text" });
      setCurrentCalId(cal.id); setLastInvite(buildInvite(cal));
      // Fire-and-forget: the calendar is already saved locally. Awaiting node bring-up here stalled
      // ~10s offline and, if it threw, surfaced a false "nothing was saved" + duplicate-creating Retry.
      startSyncing(undefined, setStatus).catch(() => {});
      setQr({ value: buildInvite(cal), title: cal.name }); // show the QR right away
    } catch (e: any) { onKeycardAbort(e, () => doCreateCal()); }
  };
  const showShare = (cal: Calendar) => { setLastInvite(buildInvite(cal)); setQr({ value: buildInvite(cal), title: cal.name }); };
  const copyInvite = async (link: string) => { await Clipboard.setStringAsync(link); Alert.alert("Copied", "Invite link copied to clipboard."); };
  const onScanned = async (data: string) => {
    setScanning(false);
    const cal = await joinFromInvite(data.trim(), joinIdentity || undefined);
    if (!cal) { Alert.alert("Not a Scala invite", "That QR isn't a scala://join link."); return; }
    startSyncing(undefined, setStatus).catch(() => {});   // fire-and-forget (offline-safe): the join is already persisted
    Alert.alert("Joined", `Syncing "${cal.name}"`);
  };
  const doJoin = async () => {
    const cal = await joinFromInvite(invite.trim(), joinIdentity || undefined);
    if (!cal) { Alert.alert("Bad invite", "Expected a scala://join?cal=…&key=… link"); return; }
    setInvite(""); startSyncing(undefined, setStatus).catch(() => {});   // fire-and-forget (offline-safe): the join is already persisted
    Alert.alert("Joined", `Syncing "${cal.name}"`);
  };
  const toggleShared = async (v: boolean) => { setShared(v); await setSharedNode(v); Alert.alert(v ? "Shared node ON" : "Shared node OFF", "Restart Scala to apply."); };
  const shiftMonth = (delta: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root} edges={["top", "left", "right", "bottom"]}>
        <StatusBar style="light" />
        <KeycardTapOverlay />
        <KeycardPinGate />


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

        <SharedNodeStatus appName="Scala" style={{ marginHorizontal: 14 }} />

        {/* view toggle + search */}
        <View style={s.viewBar}>
          <View style={s.segment}>
            {(["month", "agenda"] as const).map((m) => (
              <Pressable key={m} onPress={() => setViewMode(m)} style={[s.segBtn, viewMode === m && s.segBtnOn]}>
                <Text style={[s.segT, viewMode === m && s.segTOn]}>{m === "month" ? "Month" : "Agenda"}</Text>
              </Pressable>
            ))}
          </View>
          {viewMode === "agenda" && (
            <TextInput style={s.searchIn} value={query} onChangeText={setQuery} placeholder="Search events…" placeholderTextColor={C.sub} autoCapitalize="none" returnKeyType="search" />
          )}
        </View>

        {viewMode === "month" ? (<>
        <View style={s.grid}>
          <MonthGrid
            month={cursor.getMonth()} year={cursor.getFullYear()}
            events={monthEvents} selected={selected} colorFor={colorFor} onSelect={setSelected}
          />
        </View>

        <View style={s.dayHead}>
          <Text style={s.dayTitle}>{selected.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text>
        </View>
        <ScrollView style={{ flex: 1 }}>
          {dayEvents.length === 0 && <Text style={[s.sub, { padding: 16 }]}>No events. Tap + to add one.</Text>}
          {dayEvents.map((ev) => (
            <Pressable key={`${ev.id}-${ev.startTime}`} style={s.event} onPress={() => openEdit(ev)}>
              <View style={[s.dot, { backgroundColor: colorFor(ev.calendarId) }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.evTitle}>{ev.title}{ev.recur ? "  ↻" : ""}</Text>
                <Text style={s.sub}>
                  {ev.allDay
                    ? "All day"
                    : `${new Date(ev.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} – ${new Date(ev.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
                  {ev.location ? ` · ${ev.location}` : ""}
                  {ev.description ? ` · ${ev.description}` : ""}
                </Text>
              </View>
            </Pressable>
          ))}
          <View style={{ height: 90 }} />
        </ScrollView>
        </>) : (
        <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
          {agenda.length === 0 && <Text style={[s.sub, { padding: 16 }]}>{query.trim() ? "No matching events." : "No upcoming events in the next 90 days."}</Text>}
          {agenda.map((g) => (
            <View key={g.key}>
              <View style={s.dayHead}><Text style={s.dayTitle}>{g.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text></View>
              {g.items.map((ev) => (
                <Pressable key={`${ev.id}-${ev.startTime}`} style={s.event} onPress={() => openEdit(ev)}>
                  <View style={[s.dot, { backgroundColor: colorFor(ev.calendarId) }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.evTitle}>{ev.title}{ev.recur ? "  ↻" : ""}</Text>
                    <Text style={s.sub}>
                      {ev.allDay
                        ? "All day"
                        : `${new Date(ev.startTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} – ${new Date(ev.endTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
                      {ev.location ? ` · ${ev.location}` : ""}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))}
          <View style={{ height: 90 }} />
        </ScrollView>
        )}

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

              {/* Identities live here (device-wide, not per-calendar): manage software/Keycard
                  identities, set the default, and share an address so an owner can grant a role. */}
              <Text style={s.pLabel}>Your identities</Text>
              <IdentitiesPanel />

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
                      {!canAddTo(c) && <Text style={[s.roleBadge, { color: "#f9e2af", borderColor: "#f9e2af" }]}>read-only</Text>}
                      <SyncChip calId={c.id} />
                    </View>
                    {!!c.description && <Text style={s.sub} numberOfLines={2}>{c.description}</Text>}
                  </View>
                  <Pressable onPress={() => openCalSettings(c)} hitSlop={8}><Text style={s.share}>Edit</Text></Pressable>
                  {c.encryptionKey ? <Pressable onPress={() => showShare(c)} hitSlop={8}><Text style={s.share}>Share</Text></Pressable> : <Text style={s.sub}>local</Text>}
                </Pressable>
              ))}

              <Pressable style={[s.smBtn, { marginTop: 4, alignItems: "center" }]} onPress={() => { setNewCalName(""); setNewCalDesc(""); setNewCalSchema([]); setNewCalCanAdd(false); setNf({ key: "", label: "", type: "text" }); setNewCalOpen(true); }}>
                <Text style={s.smBtnT}>+ New calendar</Text>
              </Pressable>

              <Text style={s.pLabel}>Join a calendar</Text>
              <View style={s.row}>
                <TextInput style={[s.input, { flex: 1 }]} value={invite} onChangeText={setInvite} placeholder="scala://join?…" placeholderTextColor={C.sub} autoCapitalize="none" />
                <Pressable style={s.smBtn} onPress={doJoin}><Text style={s.smBtnT}>Join</Text></Pressable>
              </View>
              {identities.length > 1 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
                  <Text style={[s.sub, { marginRight: 2 }]}>author as</Text>
                  {identities.map((m) => (
                    <Pressable key={m.id} onPress={() => setJoinIdentity(m.id)}
                      style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, backgroundColor: joinIdentity === m.id ? "#89b4fa" : "#45475a" }}>
                      <Text style={{ color: joinIdentity === m.id ? "#1e1e2e" : "#cdd6f4", fontSize: 12, fontWeight: "600" }}>{m.label}{m.kind === "keycard" ? " 🔑" : ""}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
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

                {/* Which identity signs MY events on this calendar (rebind). Owner is fixed. */}
                <Text style={s.pLabel}>Authored by</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {identities.map((m) => (
                    <Pressable key={m.id} onPress={async () => { if (calSet) { await setCalendarIdentity(calSet.cal.id, m.id); setCalSetIdentity(m.id); } }}
                      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 12, backgroundColor: calSetIdentity === m.id ? C.primary : C.surface, borderWidth: 1, borderColor: calSetIdentity === m.id ? C.primary : C.border }}>
                      <Text style={{ color: calSetIdentity === m.id ? "#1e1e2e" : C.text, fontWeight: "600", fontSize: 13 }}>{m.label}{m.kind === "keycard" ? " 🔑" : ""}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[s.sub, { marginTop: 4 }]}>Signs your new events here. The owner is fixed — a non-owner needs a role to write.</Text>

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

                {/* #3: sharing & roles — who can edit. Identity = an address; share yours to be added. */}
                <Text style={s.pLabel}>Sharing &amp; roles</Text>
                {/* Open toggle: may anyone with the invite ADD events? (owner/editors always can;
                    everyone can only edit their OWN events; editors can edit anyone's). Owner-only. */}
                {canManage && (
                  <View style={s.rowBetween}>
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={{ color: C.text }}>Open — anyone can add events</Text>
                      <Text style={s.sub}>Off = only editors can add. Everyone can still edit only the events they created; editors edit anyone's.</Text>
                    </View>
                    <Switch
                      value={calSet?.cal.open !== false}
                      onValueChange={async (v) => { if (calSet) { await updateCalendarMeta(calSet.cal.id, { open: v }); setCalSet((s2) => s2 && { ...s2, cal: { ...s2.cal, open: v } }); } }}
                      trackColor={{ true: C.primary, false: C.border }} thumbColor="#fff"
                    />
                  </View>
                )}
                <Text style={[s.sub, { marginBottom: 6, marginTop: 8 }]}>
                  {calSet ? `Your role: ${roleOf(calSet.cal)}${roleOf(calSet.cal) === "viewer" ? " — read-only." : "."}` : ""}
                </Text>
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
                      {(["editor", "viewer"] as const).map((r) => (
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
                <Pressable style={[s.smBtn, { marginTop: 8, alignItems: "center", backgroundColor: "transparent", borderWidth: 1, borderColor: C.danger }]} onPress={removeCalendar}><Text style={[s.smBtnT, { color: C.danger }]}>Delete calendar</Text></Pressable>
                <View style={{ height: 20 }} />
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={newCalOpen} transparent animationType="slide" onRequestClose={() => setNewCalOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
            <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "90%" }}>
              <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
                <Text style={{ color: C.text, fontSize: 18, fontWeight: "700", marginBottom: 14 }}>New calendar</Text>
                <TextInput style={s.input} value={newCalName} onChangeText={setNewCalName} placeholder="Name" placeholderTextColor={C.sub} autoFocus />
                <TextInput style={[s.input, { marginTop: 10 }]} value={newCalDesc} onChangeText={setNewCalDesc} placeholder="Description (optional)" placeholderTextColor={C.sub} />
                <Text style={[s.pLabel, { marginTop: 14 }]}>Author as</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  {identities.map((m) => (
                    <Pressable key={m.id} onPress={() => setNewCalIdentity(m.id)}
                      style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 14, backgroundColor: newCalIdentity === m.id ? C.primary : C.surface, borderWidth: 1, borderColor: newCalIdentity === m.id ? C.primary : C.border }}>
                      <Text style={{ color: newCalIdentity === m.id ? "#1e1e2e" : C.text, fontWeight: "600" }}>{m.label}{m.kind === "keycard" ? " 🔑" : ""}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[s.sub, { marginTop: 8 }]}>This identity owns the calendar and signs its events. A Keycard calendar asks for your PIN + a tap.</Text>

                {/* Custom fields — same editor as settings; staged into the single cal.meta so the
                    calendar is complete on Create (a Keycard create is one tap, not create-then-edit). */}
                <Text style={s.pLabel}>Custom fields</Text>
                {newCalSchema.length === 0 && <Text style={[s.sub, { marginBottom: 6 }]}>None — a plain calendar. Add fields to capture more per event.</Text>}
                {newCalSchema.map((f) => (
                  <View key={f.key} style={s.fieldRow}>
                    <Text style={{ color: C.text, flex: 1 }}>{f.label || f.key} <Text style={{ color: C.sub, fontSize: 12 }}>· {f.type}</Text></Text>
                    <Pressable onPress={() => removeNewCalField(f.key)} hitSlop={8}><Text style={{ color: C.danger, fontSize: 18 }}>×</Text></Pressable>
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
                <Pressable style={[s.smBtn, { marginTop: 8, alignItems: "center", backgroundColor: C.surface, borderWidth: 1, borderColor: C.border }]} onPress={addNewCalField}><Text style={[s.smBtnT, { color: C.text }]}>+ Add field</Text></Pressable>

                {/* Open + signatures-required — same toggles as settings, chosen up front. */}
                <Text style={s.pLabel}>Access</Text>
                <View style={s.rowBetween}>
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={{ color: C.text }}>Open — anyone can add events</Text>
                    <Text style={s.sub}>Off = only editors can add. Everyone can still edit only the events they created.</Text>
                  </View>
                  <Switch value={newCalCanAdd} onValueChange={setNewCalCanAdd} trackColor={{ true: C.primary, false: C.border }} thumbColor="#fff" />
                </View>

                <View style={{ flexDirection: "row", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
                  <Pressable style={[s.smBtn, { backgroundColor: C.surface }]} onPress={() => setNewCalOpen(false)}><Text style={s.smBtnT}>Cancel</Text></Pressable>
                  <Pressable style={s.smBtn} onPress={doCreateCal}><Text style={s.smBtnT}>Create</Text></Pressable>
                </View>
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
          calendars={pickCals.map((c) => ({ id: c.id, name: c.name, color: colorForId(c.id) }))}
          calendarId={modal.calId}
          onPickCalendar={(id) => setModal((m) => ({ ...m, calId: id }))}
          canPickCalendar={!modal.editing}
          canEdit={modal.editing ? canEditEvent(cals.find((c) => c.id === modal.calId), modal.editing) : canAddTo(cals.find((c) => c.id === modal.calId))}
          readonlyReason={readonlyReason(cals.find((c) => c.id === modal.calId), modal.editing)}
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
  viewBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingBottom: 6 },
  segment: { flexDirection: "row", backgroundColor: C.surface, borderRadius: 9, borderWidth: 1, borderColor: C.border, overflow: "hidden" },
  segBtn: { paddingVertical: 6, paddingHorizontal: 16 },
  segBtnOn: { backgroundColor: C.primary },
  segT: { color: C.sub, fontSize: 13, fontWeight: "600" },
  segTOn: { color: C.bg },
  searchIn: { flex: 1, backgroundColor: C.surface, borderRadius: 9, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 12, paddingVertical: 6, fontSize: 13 },
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
